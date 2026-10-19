'use strict';

// Account billing data comes from Kiro CLI. Never send /usage as an AI prompt.
const { execFile } = require('node:child_process');
const usageMethod = '_kiro/account/getUsage';

function request(cli, method, params) {
    const id = cli._nextId();
    const timer = setTimeout(() => {
        const pending = cli._pendingRequests.get(id);
        cli._pendingRequests.delete(id);
        pending?.reject(new Error('查询积分超时，请稍后刷新'));
    }, 15000);
    return cli._sendRaw({ jsonrpc: '2.0', id, method, params }).finally(() => clearTimeout(timer));
}

function readAccount(cliPath) {
    return new Promise((resolve, reject) => {
        execFile(cliPath, ['whoami', '--format', 'json'], { timeout: 10000, windowsHide: true }, (error, stdout) => {
            if (error) return reject(new Error('CLI 未登录，请先登录账户再刷新积分'));
            try {
                const account = JSON.parse(stdout);
                if (!account.email) throw new Error('CLI 未返回当前账户邮箱');
                resolve(account.email);
            } catch (parseError) { reject(parseError); }
        });
    });
}

exports.normalizeUsage = function normalizeUsage(data) {
    const credits = data?.usageBreakdowns?.find(item => item.resourceType === 'CREDIT');
    if (!credits || !Number.isFinite(credits.used)) throw new Error('CLI 未返回可识别的积分用量');
    const limit = credits.hasLimit !== false && Number.isFinite(credits.limit) ? credits.limit : null;
    return {
        planName: data.planName || '', reset: data.billingCycleReset || '',
        used: credits.used, limit, remaining: limit === null ? null : Math.max(0, limit - credits.used),
        currentOverages: Number.isFinite(credits.currentOverages) ? credits.currentOverages : null,
        overagesEnabled: data.overagesEnabled === true,
        bonusCount: data.bonusCredits?.length || 0, addOnCount: data.addOnCredits?.length || 0,
    };
};

exports.install = function install({ CliProcess, ChatPanelProvider }) {
    function setup(panel) {
        if (panel._kiroUsageSetup) return;
        panel._kiroUsageSetup = true;
        panel._disposables.push({ dispose() {
            panel._kiroUsageDisposed = true;
            clearTimeout(panel._kiroUsageRefreshTimer);
            panel._kiroUsageClient?.dispose();
            panel._kiroUsageClient = null;
        } });
    }

    async function usageClient(panel, cliPath, account) {
        const active = panel._cliManager._process;
        if (active?._kiroCapabilities?._meta?.kiro?.extensionMethods?.includes(usageMethod)) return active;
        if (active?._kiroEngine === 'v2') return active;
        // CLI 2.32's V3 server does not advertise getUsage. Its native V2
        // command returns structured billing data. Keep one query-only process;
        // it never receives prompts or replaces the user's current conversation.
        if (panel._kiroUsageClient?.isAlive && panel._kiroUsageClientAccount === account) return panel._kiroUsageClient;
        panel._kiroUsageClient?.dispose();
        const cwd = panel._cliManager._getWorkspacePath();
        const cli = new CliProcess(cliPath, cwd, { engine: 'v2' });
        panel._kiroUsageClient = cli;
        panel._kiroUsageClientAccount = account;
        cli._kiroEngine = 'v2';
        try {
            await request(cli, 'initialize', { protocolVersion: 1, clientCapabilities: {},
                clientInfo: { name: 'kiro-vscode-credit-usage', version: '0.1.3-local' } });
            const response = await request(cli, 'session/new', { cwd, mcpServers: [] });
            cli._sessionId = response.result?.sessionId;
            if (!cli.sessionId) throw new Error('CLI 无法建立积分查询会话');
            return cli;
        } catch (error) { cli.dispose(); panel._kiroUsageClient = null; throw error; }
    }

    function refresh(panel, force = false) {
        setup(panel);
        if (panel._kiroUsageDisposed) return Promise.resolve();
        if (panel._kiroUsagePending) return panel._kiroUsagePending;
        if (!force && panel._kiroUsageSnapshot && Date.now() - panel._kiroUsageSnapshot.fetchedAt < 30000) {
            panel._postMessage({ type: 'creditUsage', usage: panel._kiroUsageSnapshot });
            return Promise.resolve();
        }
        panel._postMessage({ type: 'creditUsageLoading', active: true });
        panel._kiroUsagePending = (async () => {
            try {
                const cliPath = panel._cliManager.resolvedCliPath || await panel._cliManager.resolveCliPath();
                if (!cliPath) throw new Error('找不到 Kiro CLI');
                const account = await readAccount(cliPath);
                if (panel._kiroUsageDisposed) return;
                const cli = await usageClient(panel, cliPath, account);
                const native = cli._kiroCapabilities?._meta?.kiro?.extensionMethods?.includes(usageMethod);
                const response = await request(cli, native ? usageMethod : '_kiro.dev/commands/execute',
                    native ? {} : { sessionId: cli.sessionId, command: { command: 'usage', args: {} } });
                if (response.result?.success === false) throw new Error(response.result.message || 'CLI 积分查询失败');
                const data = native ? response.result?.data || response.result : response.result?.data;
                const usage = { ...exports.normalizeUsage(data), account, fetchedAt: Date.now() };
                panel._kiroUsageSnapshot = usage;
                panel._postMessage({ type: 'creditUsage', usage });
            } catch (error) {
                panel._kiroUsageClient?.dispose();
                panel._kiroUsageClient = null;
                panel._kiroUsageSnapshot = null;
                panel._postMessage({ type: 'creditUsageError', message: error.message });
            } finally {
                panel._kiroUsagePending = null;
                panel._postMessage({ type: 'creditUsageLoading', active: false });
            }
        })();
        return panel._kiroUsagePending;
    }

    const postMessage = ChatPanelProvider.prototype._postMessage;
    ChatPanelProvider.prototype._postMessage = function (message) {
        if (message.type === 'turnState') {
            if (message.active) this._kiroUsageTurning = true;
            else if (this._kiroUsageTurning) {
                this._kiroUsageTurning = false;
                setup(this);
                clearTimeout(this._kiroUsageRefreshTimer);
                this._kiroUsageRefreshTimer = setTimeout(() => { void refresh(this, true); }, 1000);
            }
        }
        return postMessage.call(this, message);
    };
    const onMessage = ChatPanelProvider.prototype._onWebviewMessage;
    ChatPanelProvider.prototype._onWebviewMessage = async function (message) {
        if (message.type === 'refreshCreditUsage') return refresh(this, !!message.force);
        const result = await onMessage.call(this, message);
        if (message.type === 'ready' && this._cliManager._process?.sessionId) void refresh(this);
        return result;
    };
};
