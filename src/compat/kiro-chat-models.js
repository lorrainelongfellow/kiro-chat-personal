'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baselineFile = path.join(os.homedir(), '.kiro', 'vscode-chat-models.json');
const actions = new Set(['ready', 'sendMessage', 'selectModel', 'resumeHistory', 'clearChat', 'deleteHistory', 'deleteHistoryBatch', 'retry', 'startSpec']);

// Only public model IDs and account identifiers are saved, never login tokens.
function readBaseline(account) {
    if (!account) return null;
    try { const ids = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))[account]; return Array.isArray(ids) ? ids : null; }
    catch { return null; }
}
function saveBaseline(account, models) {
    if (!account) return;
    try {
        let state; try { state = JSON.parse(fs.readFileSync(baselineFile, 'utf8')); } catch { state = {}; }
        state[account] = models.map(model => model.value);
        fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
        const temporary = baselineFile + '.' + process.pid + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(state), 'utf8');
        fs.renameSync(temporary, baselineFile);
    } catch { /* Optional discovery history must not block live CLI options. */ }
}

function run(cliPath, args, cwd) {
    return new Promise((resolve, reject) => {
        execFile(cliPath, args, { cwd, timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
            env: { ...process.env, KIRO_FAKE_IS_REMOTE: '1' } }, (error, stdout) => {
            if (error) return reject(new Error(args[0] === 'whoami' ? 'CLI 登录状态不可用，请先登录再刷新模型' : 'CLI 模型查询失败，请稍后刷新'));
            resolve(stdout);
        });
    });
}
function currentModels(panel) {
    return panel._cliManager._process?.configOptions.find(option => option.id === 'model')?.options || [];
}
function busy(panel) {
    return panel._kiroCatalogActionDepth > 0 || panel._kiroCatalogUiBusy || panel._kiroHistoryBusy ||
        panel._cliManager._kiroStarting || panel._cliManager._process?._kiroTurnActive;
}

exports.install = function install({ CliProcess, ChatPanelProvider }) {
    // Only manual catalog reconnects use bounded RPC waits. A failed load
    // rejects initialization so the existing history adapter disposes its candidate.
    const sendRaw = CliProcess.prototype._sendRaw;
    CliProcess.prototype._sendRaw = function (message) {
        const wait = this._kiroStartOptions?.requestTimeoutMs;
        if (!wait) return sendRaw.call(this, message);
        const timer = setTimeout(() => {
            const pending = this._pendingRequests.get(message.id);
            this._pendingRequests.delete(message.id);
            pending?.reject(new Error('刷新模型连接超时，请稍后重试'));
        }, wait);
        return sendRaw.call(this, message).finally(() => clearTimeout(timer));
    };

    function setup(panel) {
        if (panel._kiroCatalogSetup) return;
        panel._kiroCatalogSetup = true;
        panel._disposables.push({ dispose() {
            panel._kiroCatalogDisposed = true;
            clearTimeout(panel._kiroCatalogIdleTimer);
        } });
    }
    function report(panel, state, extra = {}) {
        const message = { type: 'modelCatalog', state, checkedAt: panel._kiroCatalogCheckedAt || null,
            count: currentModels(panel).length, ...extra };
        panel._kiroCatalogReport = message;
        panel._postMessage(message);
    }
    function schedule(panel) {
        if (!panel._kiroCatalogPending || panel._kiroCatalogDisposed) return;
        clearTimeout(panel._kiroCatalogIdleTimer);
        panel._kiroCatalogIdleTimer = setTimeout(() => { void apply(panel); }, 0);
    }

    async function apply(panel) {
        if (panel._kiroCatalogDisposed || panel._kiroCatalogRefreshing || !panel._kiroCatalogPending || busy(panel)) return;
        const manager = panel._cliManager, old = manager._process;
        if (!old?.sessionId) return;
        const catalog = panel._kiroCatalogPending;
        const oldModels = currentModels(panel);
        const settings = old.configOptions.filter(option => ['model', 'effortLevel', 'mode', 'autopilot'].includes(option.id))
            .map(option => ({ id: option.id, value: option.currentValue }));
        panel._kiroCatalogRefreshing = true;
        report(panel, 'refreshing');
        panel._postMessage({ type: 'loading', active: true });
        try {
            // Restart the same native session; no new conversation or prompt.
            const cli = await manager.restartProcess({ requestTimeoutMs: 15000 });
            for (const setting of settings) {
                const option = cli.configOptions.find(item => item.id === setting.id);
                if (setting.value && option?.currentValue !== setting.value && option?.options.some(item => item.value === setting.value)) {
                    await cli.setConfigOption(setting.id, setting.value);
                }
            }
            delete cli._kiroStartOptions.requestTimeoutMs;
            cli._kiroOnConfigOptions = options => {
                if (manager._process === cli) panel._postMessage({ type: 'configOptions', options });
            };
            panel._postMessage({ type: 'configOptions', options: cli.configOptions });
            const available = currentModels(panel);
            const added = available.filter(model => !oldModels.some(oldModel => oldModel.value === model.value) ||
                (catalog.seen && !catalog.seen.includes(model.value))).map(model => model.name || model.value);
            const removed = oldModels.filter(model => !available.some(next => next.value === model.value)).map(model => model.name || model.value);
            panel._kiroCatalogFingerprint = catalog.fingerprint;
            panel._kiroCatalogCheckedAt = Date.now();
            saveBaseline(catalog.account, available);
            report(panel, 'updated', { added, removed });
        } catch (error) {
            if (manager._process) panel._postMessage({ type: 'configOptions', options: manager._process.configOptions });
            report(panel, 'error', { message: error.message });
        } finally {
            panel._kiroCatalogPending = null;
            panel._kiroCatalogRefreshing = false;
            panel._postMessage({ type: 'loading', active: false });
        }
    }

    ChatPanelProvider.prototype._kiroCheckModelCatalog = function (force = false) {
        setup(this);
        if (this._kiroCatalogDisposed) return Promise.resolve();
        if (this._kiroCatalogChecking) return this._kiroCatalogChecking;
        if (!force && this._kiroCatalogCheckedAt) {
            if (this._kiroCatalogReport) this._postMessage(this._kiroCatalogReport);
            schedule(this);
            return Promise.resolve();
        }
        report(this, 'checking');
        this._kiroCatalogChecking = (async () => {
            try {
                const manager = this._cliManager;
                const cliPath = manager.resolvedCliPath || await manager.resolveCliPath();
                if (!cliPath) throw new Error('找不到 Kiro CLI');
                const identity = JSON.parse(await run(cliPath, ['whoami', '--format', 'json'], manager._getWorkspacePath()));
                const account = identity.email;
                if (this._kiroCatalogDisposed) return;
                const data = JSON.parse(await run(cliPath, ['chat', '--list-models', '--format', 'json'], manager._getWorkspacePath()));
                if (!Array.isArray(data.models) || !data.models.length || data.models.some(model => typeof model.model_id !== 'string')) {
                    throw new Error('CLI 未返回有效模型列表');
                }
                if (this._kiroCatalogDisposed) return;
                const models = data.models;
                const fingerprint = JSON.stringify(models.map(model => [model.model_id, model.description, model.rate_multiplier, model.context_window_tokens]).sort((a, b) => a[0].localeCompare(b[0])));
                const available = currentModels(this);
                const seen = readBaseline(account);
                const added = models.filter(model => !available.some(item => item.value === model.model_id)).map(model => model.model_name || model.model_id);
                const removed = available.filter(item => !models.some(model => model.model_id === item.value));
                this._kiroCatalogCheckedAt = Date.now();
                if (force || added.length || removed.length || (this._kiroCatalogFingerprint && this._kiroCatalogFingerprint !== fingerprint)) {
                    this._kiroCatalogPending = { fingerprint, account, seen };
                    if (busy(this)) report(this, 'pending', { added });
                    schedule(this);
                } else {
                    this._kiroCatalogFingerprint = fingerprint;
                    const discovered = seen ? available.filter(model => !seen.includes(model.value)).map(model => model.name || model.value) : [];
                    saveBaseline(account, available);
                    report(this, discovered.length ? 'updated' : 'checked', { added: discovered });
                }
            } catch (error) { this._kiroCatalogPending = null; report(this, 'error', { message: error.message }); }
            finally { this._kiroCatalogChecking = null; }
        })();
        return this._kiroCatalogChecking;
    };

    const postMessage = ChatPanelProvider.prototype._postMessage;
    ChatPanelProvider.prototype._postMessage = function (message) {
        if (message.type === 'loading') this._kiroCatalogUiBusy = !!message.active;
        const result = postMessage.call(this, message);
        if ((message.type === 'turnState' || message.type === 'loading') && !message.active) schedule(this);
        return result;
    };
    const onMessage = ChatPanelProvider.prototype._onWebviewMessage;
    ChatPanelProvider.prototype._onWebviewMessage = async function (message) {
        if (message.type === 'refreshModels') return this._kiroCheckModelCatalog(!!message.force);
        if (this._kiroCatalogRefreshing && actions.has(message.type)) return;
        const action = actions.has(message.type);
        if (action) this._kiroCatalogActionDepth = (this._kiroCatalogActionDepth || 0) + 1;
        try {
            const result = await onMessage.call(this, message);
            if (message.type === 'ready') {
                setup(this);
                if (this._kiroCatalogReport) this._postMessage(this._kiroCatalogReport);
                else report(this, 'manual');
            }
            return result;
        } finally {
            if (action) this._kiroCatalogActionDepth--;
            schedule(this);
        }
    };
};
