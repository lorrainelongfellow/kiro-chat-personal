'use strict';

const { execFile, spawn } = require('node:child_process');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const manifestUrl = 'https://prod.download.cli.kiro.dev/stable/latest/manifest.json';
const patchVersion = '1.1.4';

function run(file, args) {
    return new Promise((resolve, reject) => execFile(file, args, { timeout: 12000, maxBuffer: 1024 * 1024,
        windowsHide: true, env: { ...process.env, KIRO_FAKE_IS_REMOTE: '1' } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}
async function identity(file) {
    const data = JSON.parse(await run(file, ['whoami', '--format', 'json']));
    if (!data.email) throw new Error('CLI 未返回已登录账户');
    return { email: data.email, accountType: data.accountType || '', checkedAt: Date.now() };
}
function latestVersion() {
    return new Promise((resolve, reject) => {
        const request = https.get(manifestUrl, { headers: { Accept: 'application/json' } }, response => {
            if (response.statusCode !== 200) { response.resume(); reject(new Error('官方版本清单返回 HTTP ' + response.statusCode)); return; }
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) request.destroy(new Error('版本清单过大')); });
            response.on('error', reject);
            response.on('end', () => {
                try { const data = JSON.parse(text); if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(data.version)) throw new Error('无效的官方版本信息'); resolve(data.version); }
                catch (error) { reject(error); }
            });
        });
        request.setTimeout(10000, () => request.destroy(new Error('官方版本查询超时，请检查网络后重试')));
        request.on('error', reject);
    });
}
function compareVersions(a, b) {
    const left = a.split(/[.-]/), right = b.split(/[.-]/);
    for (let i = 0; i < 3; i++) { const difference = Number(left[i]) - Number(right[i]); if (difference) return Math.sign(difference); }
    return left.length > 3 && right.length === 3 ? -1 : left.length === 3 && right.length > 3 ? 1 : 0;
}

exports.installLogin = function installLogin({ CliManager, vscode }) {
    if (CliManager.prototype._kiroDeviceLoginInstalled) return;
    CliManager.prototype._kiroDeviceLoginInstalled = true;
    CliManager.prototype.login = async function () {
        if (this._personalLoginPending) { this._personalLoginTerminal?.show(); return this._personalLoginPending; }
        const cliPath = this.resolvedCliPath || await this.resolveCliPath();
        if (!cliPath) throw new Error('请先安装 Kiro CLI');
        try { await identity(cliPath); return true; } catch { /* Start explicit device authorization. */ }
        this._personalLoginPending = new Promise(resolve => {
            const write = new vscode.EventEmitter(), close = new vscode.EventEmitter();
            let child, finished = false;
            const finish = async (code, error) => {
                if (finished) return;
                finished = true;
                if (error) write.fire('\r\n登录程序错误：' + error.message + '\r\n');
                let success = false;
                try { await identity(cliPath); success = true; } catch { /* Cancellation or failed authentication. */ }
                write.fire(success ? '\r\n登录成功，可以返回 Kiro 面板。\r\n' : '\r\n未完成登录，可再次点击登录。\r\n');
                close.fire(success ? 0 : code || 1); write.dispose(); close.dispose(); resolve(success);
            };
            const pty = { onDidWrite: write.event, onDidClose: close.event,
                open: () => {
                    write.fire('请按 Ctrl+Shift+N 打开新的 Chrome 无痕窗口，手动打开下方授权地址，选择 AWS Builder ID 并完成授权。\r\n不会自动打开普通浏览器。按 Ctrl+C 可取消。\r\n\r\n');
                    child = spawn(cliPath, ['login', '--use-device-flow', '--license', 'free'], {
                        windowsHide: true, env: { ...process.env, KIRO_FAKE_IS_REMOTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
                    const output = chunk => write.fire(chunk.toString().replace(/\r?\n/g, '\r\n'));
                    child.stdout.on('data', output); child.stderr.on('data', output);
                    child.on('error', error => { void finish(1, error); }); child.on('close', code => { void finish(code); });
                }, handleInput: data => { if (data.includes('\x03')) child?.kill(); }, close: () => { child?.kill(); void finish(1); } };
            this._personalLoginTerminal = vscode.window.createTerminal({ name: 'Kiro 设备码登录', pty });
            this._personalLoginTerminal.show();
        }).finally(() => { this._personalLoginPending = null; });
        return this._personalLoginPending;
    };
    const dispose = CliManager.prototype.dispose;
    CliManager.prototype.dispose = function () { this._personalLoginTerminal?.dispose(); return dispose.call(this); };
};

exports.install = function install({ CliManager, ChatPanelProvider, vscode }) {
    exports.installLogin({ CliManager, vscode });
    function publishAccount(panel, account, error = '') {
        panel._kiroManagedAccount = account;
        panel._kiroAccountMessage = '当前账户：' + (account?.email || '未登录');
        panel._postMessage({ type: 'systemMessage', message: panel._kiroAccountMessage });
        panel._postMessage({ type: 'accountState', account, error });
    }
    async function readAccount(panel) {
        const manager = panel._cliManager;
        const file = manager.resolvedCliPath || await manager.resolveCliPath();
        if (!file) throw new Error('找不到 Kiro CLI，请检查 CLI 路径');
        try { const account = await identity(file); publishAccount(panel, account); return account; }
        catch { publishAccount(panel, null, '未登录或登录状态查询失败，可重新核对或登录'); return null; }
    }
    function stopConnection(panel) {
        const manager = panel._cliManager, cli = manager._process;
        manager._process = null; cli?.dispose();
        clearTimeout(panel._kiroUsageRefreshTimer);
        panel._kiroUsageClient?.dispose(); panel._kiroUsageClient = null; panel._kiroUsageSnapshot = null;
        panel._kiroCatalogPending = null; panel._kiroCatalogReport = null; panel._kiroCatalogCheckedAt = null;
        panel._postMessage({ type: 'creditUsageError', message: '请登录后刷新积分' });
        panel._postMessage({ type: 'accountDisconnected' });
        manager._setState({ status: 'not_authenticated' });
    }
    function blocked(panel) {
        return panel._kiroAccountAction || panel._cliManager._kiroStarting || panel._cliManager._process?._kiroTurnActive ||
            panel._kiroHistoryBusy || panel._kiroCatalogRefreshing || panel._kiroCatalogChecking || panel._kiroCatalogPending || panel._kiroUsagePending;
    }
    async function diagnostics(panel, checkUpdates) {
        panel._postMessage({ type: 'diagnosticsLoading', active: true });
        const manager = panel._cliManager;
        const data = { checkedAt: Date.now(), platform: process.platform, workspace: manager._getWorkspacePath(),
            connection: manager._process?.isAlive ? '已连接（本机 CLI 会话）' : '未连接',
            engine: manager._process?._kiroEngine || '—', modelCount: manager._process?.configOptions.find(option => option.id === 'model')?.options.length || 0 };
        try {
            const metadata = JSON.parse(fs.readFileSync(path.join(panel._extensionUri.fsPath, 'package.json'), 'utf8'));
            data.extensionVersion = metadata.version; data.extensionName = metadata.displayName;
            data.patchVersion = patchVersion;
            data.cliPath = manager.resolvedCliPath || await manager.resolveCliPath();
            if (!data.cliPath) throw new Error('找不到 Kiro CLI');
            data.updateCommand = process.platform === 'win32' ? "& '" + data.cliPath.replaceAll("'", "''") + "' update" : "'" + data.cliPath.replaceAll("'", "'\\''") + "' update";
            const [version, account] = await Promise.allSettled([run(data.cliPath, ['--version']), identity(data.cliPath)]);
            data.cliVersion = version.status === 'fulfilled' ? version.value.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || version.value : '读取失败';
            data.account = account.status === 'fulfilled' ? account.value.email : '未登录或查询失败';
            if (checkUpdates) {
                try { data.latestVersion = await latestVersion(); data.updateState = /^\d+\.\d+\.\d+/.test(data.cliVersion) ? compareVersions(data.cliVersion, data.latestVersion) : null; data.updateCheckedAt = Date.now(); }
                catch (error) { data.updateError = error.message; }
            } else if (panel._kiroDiagnostics?.updateCheckedAt) {
                Object.assign(data, Object.fromEntries(['latestVersion', 'updateState', 'updateCheckedAt'].map(key => [key, panel._kiroDiagnostics[key]])));
                if (/^\d+\.\d+\.\d+/.test(data.cliVersion)) data.updateState = compareVersions(data.cliVersion, data.latestVersion);
            }
        } catch (error) { data.error = error.message; }
        panel._kiroDiagnostics = data;
        panel._postMessage({ type: 'diagnostics', data });
        panel._postMessage({ type: 'diagnosticsLoading', active: false });
    }
    const onMessage = ChatPanelProvider.prototype._onWebviewMessage;
    ChatPanelProvider.prototype._onWebviewMessage = async function (message) {
        try {
            if (message.type === 'refreshAccount') {
                this._postMessage({ type: 'accountLoading', active: true });
                try { await readAccount(this); } finally { this._postMessage({ type: 'accountLoading', active: false }); }
                return;
            }
            if (message.type === 'getDiagnostics' || message.type === 'checkCliUpdate') return diagnostics(this, message.type === 'checkCliUpdate');
            if (message.type === 'copyDiagnostics') {
                if (this._kiroDiagnostics) { await vscode.env.clipboard.writeText(JSON.stringify(this._kiroDiagnostics, null, 2)); this._postMessage({ type: 'managementNotice', message: '诊断信息已复制（不含登录令牌）' }); }
                return;
            }
            if (['loginAccount', 'switchAccount', 'logoutAccount', 'reconnectAccount'].includes(message.type)) {
                if (blocked(this)) { this._postMessage({ type: 'managementNotice', message: '请等待当前操作结束后再管理账户或连接' }); return; }
                this._kiroAccountAction = true;
                this._postMessage({ type: 'accountLoading', active: true }); this._postMessage({ type: 'loading', active: true });
                try {
                    const manager = this._cliManager, file = manager.resolvedCliPath || await manager.resolveCliPath();
                    if (!file) throw new Error('请先安装 Kiro CLI');
                    if (message.type === 'switchAccount' || message.type === 'logoutAccount') {
                        await run(file, ['logout']); stopConnection(this); publishAccount(this, null);
                    }
                    if (message.type !== 'logoutAccount') {
                        if (message.type === 'reconnectAccount') { stopConnection(this); if (!await readAccount(this)) return; }
                        else if (!await manager.login()) { publishAccount(this, null, '未完成登录，可再次点击登录'); return; }
                        await readAccount(this);
                        await onMessage.call(this, { type: 'ready' });
                    }
                } finally { this._kiroAccountAction = false; this._postMessage({ type: 'accountLoading', active: false }); this._postMessage({ type: 'loading', active: false }); }
                return;
            }
            if (this._kiroAccountAction && ['sendMessage', 'clearChat', 'resumeHistory', 'deleteHistory', 'deleteHistoryBatch', 'selectModel', 'refreshModels', 'refreshCreditUsage', 'retry', 'startSpec', 'ready'].includes(message.type)) return;
            return await onMessage.call(this, message);
        } catch (error) { this._postMessage({ type: 'managementNotice', message: error.message }); }
    };
};
