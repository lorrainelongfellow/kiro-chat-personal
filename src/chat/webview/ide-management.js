'use strict';

window.installKiroManagement = function ({ api, state, node, $, closePopups, status }) {
    let accountBusy = false, diagnosticsBusy = false, batch = null, account = null;
    const time = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
    function details(target, rows) {
        target.replaceChildren();
        for (const [label, value] of rows) {
            const row = node('div', 'detail-row'); row.append(node('span', 'muted', label), node('span', '', value || '—')); target.append(row);
        }
    }
    window.kiroManagementControls = function () {
        for (const id of ['account-login', 'account-switch', 'account-logout', 'diagnostics-reconnect']) $(id).disabled = state.busy || accountBusy;
        $('account-refresh').disabled = accountBusy;
        $('account-login').classList.toggle('hidden', !!account);
        $('account-switch').classList.toggle('hidden', !account);
        $('account-logout').classList.toggle('hidden', !account);
        $('diagnostics-refresh').disabled = diagnosticsBusy; $('cli-check-update').disabled = diagnosticsBusy;
        for (const button of document.querySelectorAll('.history-actions button')) button.disabled = state.busy || state.historyBusy;
    };
    for (const button of document.querySelectorAll('.management-close')) button.addEventListener('click', () => closePopups());
    for (const [id, type] of [['account-refresh', 'refreshAccount'], ['account-login', 'loginAccount'], ['account-switch', 'switchAccount'], ['account-logout', 'logoutAccount'],
        ['diagnostics-refresh', 'getDiagnostics'], ['cli-check-update', 'checkCliUpdate'], ['diagnostics-copy', 'copyDiagnostics'], ['diagnostics-reconnect', 'reconnectAccount'], ['changes-refresh', 'listTurnChanges'], ['changes-workspace', 'openWorkspaceChanges']]) {
        $(id).addEventListener('click', () => api.postMessage({ type }));
    }
    function renderChanges() {
        const list = $('changes-list'); list.replaceChildren();
        const count = batch?.totalFiles ?? batch?.files.length ?? 0;
        $('changes-count').textContent = !batch ? '—' : !batch.finishedAt ? '…' : batch.incomplete ? count ? count + '+' : '?' : String(count);
        for (const file of batch?.files || []) {
            const row = node('div', 'change-row');
            const top = node('div', 'change-heading');
            top.append(node('span', 'change-kind ' + file.status, { added: '新增', deleted: '删除', modified: '修改', reported: '涉及' }[file.status]), node('span', 'change-name', file.name));
            row.append(top, node('div', 'change-detail', file.source + (file.detail ? ' · ' + file.detail : '')));
            const actions = node('div', 'management-actions');
            for (const [type, label] of [['openTurnDiff', '查看差异'], ['openTurnFile', '打开文件']]) {
                const button = node('button', 'text-button', label);
                button.disabled = type === 'openTurnDiff' ? file.diffKind === 'unavailable' : file.status === 'deleted';
                button.addEventListener('click', () => api.postMessage({ type, batchId: batch.id, fileId: file.id })); actions.append(button);
            }
            row.append(actions); list.append(row);
        }
        if (!batch?.files.length) list.append(node('div', 'empty-list', !batch ? '发送任务后显示本轮文件变化；已有未提交修改可点“工作区改动”' : !batch.finishedAt ? '任务执行中，结束后汇总文件变化…' : batch.incomplete ? '当前汇总不完整，无法确认本轮是否有文件变化' : '本轮未检测到文件内容变化'));
        $('changes-status').textContent = (batch?.finishedAt ? '汇总于 ' + time(batch.finishedAt) + '。' : '') +
            '比较本轮开始前与结束后的内容，可能包含同期手动编辑。' + (batch?.warnings.length ? '\n' + batch.warnings.join('\n') : '');
    }
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'accountState':
                account = message.account;
                details($('account-details'), [['当前账户', account?.email || '未登录'], ['登录方式', account?.accountType || '—']]);
                $('account-status').textContent = message.error || (account ? '核对于 ' + time(account.checkedAt) : '已退出，可重新登录');
                window.kiroManagementControls(); break;
            case 'accountLoading': accountBusy = message.active; if (accountBusy) $('account-status').textContent = '正在处理账户操作…'; window.kiroManagementControls(); break;
            case 'accountDisconnected':
                state.options = []; state.credits = null; state.disconnected = true; $('connection-dot').classList.remove('connected');
                $('model-label').textContent = '请登录或重新连接'; break;
            case 'diagnosticsLoading': diagnosticsBusy = message.active; if (diagnosticsBusy) $('diagnostics-status').textContent = '正在读取诊断信息…'; window.kiroManagementControls(); break;
            case 'diagnostics': {
                const data = message.data;
                const update = data.updateError ? '查询失败：' + data.updateError : data.latestVersion ? data.updateState === null ? '官方最新 ' + data.latestVersion :
                    data.updateState < 0 ? '有新版 ' + data.latestVersion : data.updateState > 0 ? '当前版本高于稳定版 ' + data.latestVersion : '已是最新稳定版 ' + data.latestVersion : '未检查，点击下方按钮';
                const release = data.patchVersion && data.patchVersion !== data.extensionVersion ? '（改造 ' + data.patchVersion + '）' : '';
                details($('diagnostics-details'), [['插件', (data.extensionName || 'Kiro') + ' ' + (data.extensionVersion || '') + release], ['CLI 版本', data.cliVersion], ['CLI 路径', data.cliPath],
                    ['账户', data.account], ['会话连接', data.connection], ['会话引擎', data.engine], ['可用模型', String(data.modelCount)], ['CLI 更新', update], ['升级命令', data.updateCommand], ['工作区', data.workspace]]);
                $('diagnostics-status').textContent = data.error || '诊断于 ' + time(data.checkedAt) + (data.updateCheckedAt ? ' · 官方版本查询于 ' + time(data.updateCheckedAt) : '') + '\n插件通过 VSIX 手动更新；CLI 可在终端执行 kiro-cli update 升级。';
                break;
            }
            case 'managementNotice': $('account-status').textContent = message.message; $('diagnostics-status').textContent = message.message; status(message.message); break;
            case 'turnChanges': batch = message.batch; renderChanges(); break;
        }
    });
};
