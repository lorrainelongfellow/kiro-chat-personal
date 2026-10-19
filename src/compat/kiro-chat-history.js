'use strict';

// Conversation content remains in Kiro's native store. This file stores only UI
// titles and the last selected session, and restores context through ACP.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const stateFile = path.join(os.homedir(), '.kiro', 'vscode-chat-personal', 'ui-state.json');

function workspaceKey(cwd) {
    const resolved = path.resolve(cwd.replace(/^\\\\\?\\/, ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readState() {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { workspaces: {}, titles: {} }; throw error; }
}

function saveState(update) {
    const state = readState();
    update(state);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const temporary = stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(state), 'utf8');
    fs.renameSync(temporary, stateFile);
}

function remember(manager, cli) {
    saveState(state => {
        state.workspaces[workspaceKey(manager._getWorkspacePath())] = {
            sessionId: cli.sessionId, engine: cli._kiroEngine, title: cli._kiroTitle,
        };
    });
}

const transcriptImageBytes = new WeakMap();
function appendUpdate(transcript, update) {
    const type = update.sessionUpdate;
    if (type === 'user_message_chunk' && update.content?.type === 'image') {
        const { mimeType, data } = update.content;
        const used = transcriptImageBytes.get(transcript) || 0;
        const last = transcript.at(-1);
        const messageId = update._meta?.kiro?.messageId || update._meta?.messageId;
        const entry = last?.role === 'user' && (!messageId || last.messageId === messageId) ? last : { role: 'user', text: '', messageId };
        if (entry !== last) transcript.push(entry);
        if (['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) && typeof data === 'string' && data.length > 0 &&
            data.length <= Math.ceil(5 * 1024 * 1024 / 3) * 4 && used + data.length <= 28 * 1024 * 1024) {
            transcriptImageBytes.set(transcript, used + data.length);
            (entry.images ||= []).push({ name: '历史图片', url: 'data:' + mimeType + ';base64,' + data });
        } else entry.text += '\n[图片附件：预览未恢复]';
        return;
    }
    if (type === 'user_message_chunk' || type === 'agent_message_chunk') {
        const role = type === 'user_message_chunk' ? 'user' : 'assistant';
        const text = update.content?.type === 'text' ? update.content.text : '';
        if (!text) return;
        const messageId = update._meta?.kiro?.messageId || update._meta?.messageId;
        const last = transcript.at(-1);
        if (last?.role === role && (!messageId || last.messageId === messageId)) last.text += text;
        else transcript.push({ role, text, messageId });
    } else if (type === 'tool_call' && update.title) {
        transcript.push({ role: 'tool', text: update.title, toolCallId: update.toolCallId, status: update.status });
    } else if (type === 'tool_call_update') {
        const tool = transcript.findLast(entry => entry.toolCallId === update.toolCallId);
        if (tool && update.status) tool.status = update.status;
    }
}

async function listSessions(manager, includeEmpty = false) {
    const cliPath = manager.resolvedCliPath || await manager.resolveCliPath();
    if (!cliPath) throw new Error('找不到 Kiro CLI');
    const cwd = manager._getWorkspacePath();
    const data = await new Promise((resolve, reject) => {
        execFile(cliPath, ['chat', '--list-sessions', '--format', 'json'],
            { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
                env: { ...process.env, KIRO_FAKE_IS_REMOTE: '1' } }, (error, stdout) => {
                if (error) return reject(error);
                try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
            });
    });
    const { titles, pinned = {} } = readState();
    return data.filter(group => workspaceKey(group.cwd) === workspaceKey(cwd))
        .flatMap(group => group.sessions)
        .filter(session => session.source === 'v2' || session.source === 'v3')
        .filter(session => includeEmpty || session.messageCount !== 0 || session.sessionId === manager._process?.sessionId)
        .map(session => ({
            sessionId: session.sessionId,
            engine: session.source,
            title: titles[session.sessionId] || (session.title === '(no title)' ? '新对话' : session.title),
            updatedAt: session.updatedAt,
            messageCount: session.messageCount,
            pinned: !!pinned[session.sessionId],
        }))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

exports.install = function install({ CliProcess, CliManager, ChatPanelProvider, vscode }) {
    const processLine = CliProcess.prototype._processLine;
    CliProcess.prototype._processLine = function (line) {
        let message;
        try { message = JSON.parse(line); } catch { return processLine.call(this, line); }
        const update = message.method === 'session/update' ? message.params?.update : null;
        if (['config_option_update', 'config_options_update'].includes(update?.sessionUpdate) && Array.isArray(update.configOptions)) {
            this._kiroLatestConfigOptions = this._parseConfigOptions(update);
            this._configOptions = this._kiroLatestConfigOptions;
            this._kiroConfigRevision = (this._kiroConfigRevision || 0) + 1;
            this._kiroModelCatalogReady = this._configOptions.some(option => option.id === 'model');
            this._kiroOnConfigOptions?.(this._configOptions);
        }
        return processLine.call(this, line);
    };

    CliProcess.prototype.initializeAndCreateSession = async function (cwd) {
        this._kiroWorkspacePath = cwd;
        this._kiroTranscript = [];
        this._kiroEngine = this._kiroStartOptions.engine || 'v2';
        const init = await this._sendRaw({
            jsonrpc: '2.0', id: this._nextId(), method: 'initialize',
            params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'kiro-vscode-chat', version: '0.1.3-local' } },
        });
        this._kiroCapabilities = init.result?.agentCapabilities || {};
        const target = this._kiroStartOptions.sessionId;
        const params = { cwd, mcpServers: [] };
        let saved;
        if (target) {
            if (!init.result?.agentCapabilities?.loadSession) throw new Error('当前 CLI 不支持恢复历史会话');
            params.sessionId = target;
            if (this._kiroEngine === 'v2') {
                // The v2 adapter requires the native metadata file as an ACP hint.
                if (!/^[\da-f-]{36}$/i.test(target)) throw new Error('无效的历史会话 ID');
                const sessionFile = path.join(os.homedir(), '.kiro', 'sessions', 'cli', target + '.json');
                saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
                if (workspaceKey(saved.cwd) !== workspaceKey(cwd)) throw new Error('历史会话属于其他工作区');
                params._meta = { '_kiro.dev/session_file': sessionFile };
            }
        }
        this._onSessionUpdate = update => appendUpdate(this._kiroTranscript, update);
        let response;
        try {
            response = await this._sendRaw({
                jsonrpc: '2.0', id: this._nextId(), method: target ? 'session/load' : 'session/new', params,
            });
        } finally { this._onSessionUpdate = null; }
        this._sessionId = target || response.result?.sessionId;
        this._kiroModes = response.result?.modes;
        if (!this._sessionId) throw new Error('CLI 没有返回会话 ID');
        this._configOptions = this._kiroLatestConfigOptions || this._parseConfigOptions(response.result);
        this._kiroTitle = this._kiroStartOptions.title || saved?.title || (target ? 'Kiro 对话' : '新对话');
        this._kiroEffortValue = saved?.session_state?.rts_model_state?.additional_fields?.overrides?.output_config?.effort || '';
        await this.refreshEffortOptions();
        if (this._kiroEngine === 'v3') {
            // V3 publishes the complete model catalog asynchronously after load.
            const deadline = Date.now() + 5000;
            while (!this._kiroModelCatalogReady && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 40));
            }
        }
        return this._sessionId;
    };

    const setConfigOption = CliProcess.prototype.setConfigOption;
    CliProcess.prototype.setConfigOption = async function (configId, value) {
        const revision = this._kiroConfigRevision || 0;
        const options = await setConfigOption.call(this, configId, value);
        if ((this._kiroConfigRevision || 0) !== revision && this._kiroLatestConfigOptions) {
            this._configOptions = this._kiroLatestConfigOptions;
            return this._configOptions;
        }
        return options;
    };

    const sendPrompt = CliProcess.prototype.sendPrompt;
    CliProcess.prototype.sendPrompt = async function (text, onUpdate) {
        if (this._kiroTurnActive) throw new Error('当前对话正在生成回复');
        this._kiroTurnActive = true;
        this._kiroTranscript.push({ role: 'user', text });
        try {
            return await sendPrompt.call(this, text, update => {
                appendUpdate(this._kiroTranscript, update);
                onUpdate(update);
            });
        } finally { this._kiroTurnActive = false; }
    };

    async function createProcess(manager, options, configure) {
        if (manager._process?._kiroTurnActive) throw new Error('请等待当前回复完成，再切换对话');
        const cliPath = manager.resolvedCliPath || await manager.resolveCliPath();
        if (!cliPath) throw new Error('找不到 Kiro CLI');
        const candidate = new CliProcess(cliPath, manager._getWorkspacePath(), options);
        try {
            await candidate.initializeAndCreateSession(manager._getWorkspacePath());
            if (configure) await configure(candidate);
            remember(manager, candidate);
        }
        catch (error) { candidate.dispose(); throw error; }
        const previous = manager._process;
        manager._process = candidate;
        candidate.onDidExit(info => {
            if (manager._process !== candidate) return;
            manager._process = null;
            manager._setState({ status: 'ready', cliPath });
            if (info.code !== 0 && info.code !== null && !manager._isReconnecting) manager._attemptAutoReconnect();
        });
        previous?.dispose();
        manager._setState({ status: 'running', cliPath, process: candidate });
        return candidate;
    }

    CliManager.prototype.ensureProcess = function () {
        if (this._kiroStarting) return this._kiroStarting;
        if (this._process?.isAlive) return Promise.resolve(this._process);
        const saved = readState().workspaces[workspaceKey(this._getWorkspacePath())];
        this._kiroStarting = createProcess(this, saved || { engine: 'v3' }).finally(() => { this._kiroStarting = null; });
        return this._kiroStarting;
    };
    CliManager.prototype.restartProcess = function (extraOptions = {}) {
        const active = this._process;
        const options = active ? { sessionId: active.sessionId, engine: active._kiroEngine } :
            readState().workspaces[workspaceKey(this._getWorkspacePath())] || {};
        // A session cannot be owned by two processes; release it before reconnect.
        this._process = null;
        active?.dispose();
        this._kiroStarting = createProcess(this, { ...options, ...extraOptions }).finally(() => { this._kiroStarting = null; });
        return this._kiroStarting;
    };

    function showConversation(panel, cli) {
        cli._kiroOnConfigOptions = options => {
            if (panel._cliManager._process === cli) panel._postMessage({ type: 'configOptions', options });
        };
        panel._lastFailedMessage = null;
        panel._postMessage({ type: 'restoreConversation', entries: cli._kiroTranscript, account: panel._kiroAccountMessage || '' });
        panel._postMessage({ type: 'configOptions', options: cli.configOptions });
        panel._postMessage({ type: 'contextUsage', usage: { total: 0 } });
        panel._postMessage({
            type: 'currentSession', sessionId: cli.sessionId,
            title: readState().titles[cli.sessionId] || cli._kiroTitle,
        });
    }

    async function openHistory(panel) {
        try {
            panel._postMessage({ type: 'historyLoading', active: true });
            const sessions = await listSessions(panel._cliManager);
            panel._kiroHistoryEntries = new Map(sessions.map(session => [session.sessionId, session]));
            panel._postMessage({ type: 'historyList', sessions, currentSessionId: panel._cliManager._process?.sessionId });
        } catch (error) {
            panel._postMessage({ type: 'historyError', message: '读取历史失败：' + error.message });
        } finally { panel._postMessage({ type: 'historyLoading', active: false }); }
    }

    async function waitForExit(cli) {
        const child = cli?._process;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        await new Promise((resolve, reject) => {
            const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
            const timer = setTimeout(() => { child.removeListener('exit', done); reject(new Error('原对话连接尚未释放，请稍后再删除')); }, 5000);
            child.once('exit', done);
        });
    }

    async function deleteConversation(panel, entry, { confirmed = false, quiet = false } = {}) {
        const confirmation = confirmed || await vscode.window.showWarningMessage('删除对话“' + entry.title + '”？',
            { modal: true, detail: '将永久删除这条本机 Kiro CLI 历史记录，无法撤销。删除当前对话时会自动打开新对话。' }, '删除');
        if (confirmation !== true && confirmation !== '删除') return;
        const manager = panel._cliManager, old = manager._process;
        const deletingCurrent = old?.sessionId === entry.sessionId;
        const settings = old?.configOptions.filter(option => ['model', 'effortLevel', 'mode', 'autopilot'].includes(option.id))
            .map(option => ({ id: option.id, value: option.currentValue })) || [];
        const configure = async cli => {
            for (const setting of settings) {
                const option = cli.configOptions.find(item => item.id === setting.id);
                if (setting.value && option?.currentValue !== setting.value && option?.options.some(item => item.value === setting.value)) await cli.setConfigOption(setting.id, setting.value);
            }
        };
        let replacement, canRestore = true;
        try {
            if (deletingCurrent) {
                replacement = await createProcess(manager, { engine: 'v3', requestTimeoutMs: 10000 }, configure);
                delete replacement._kiroStartOptions.requestTimeoutMs;
                showConversation(panel, replacement);
                await waitForExit(old);
            }
            const cliPath = manager.resolvedCliPath || await manager.resolveCliPath();
            if (!cliPath) throw new Error('找不到 Kiro CLI');
            let deletionError;
            try {
                await new Promise((resolve, reject) => execFile(cliPath, ['chat', '--delete-session', entry.sessionId,
                    ...(entry.engine === 'v3' ? ['--v3'] : ['--session-source', 'v2'])],
                { cwd: manager._getWorkspacePath(), timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
                    env: { ...process.env, KIRO_FAKE_IS_REMOTE: '1' } }, error => error ? reject(error) : resolve()));
            } catch (error) { deletionError = error; }
            let remaining;
            try { remaining = await listSessions(manager, true); }
            catch {
                canRestore = false;
                const error = new Error('已发送删除请求，但暂时无法确认结果，请刷新历史列表');
                error.stopBatch = true;
                throw error;
            }
            if (remaining.some(item => item.sessionId === entry.sessionId && item.engine === entry.engine)) {
                throw new Error(deletionError ? 'CLI 删除失败，原记录仍保留：' + deletionError.message : 'CLI 未删除该记录，可能仍被其他窗口占用');
            }
            canRestore = false;
            let warning = '';
            try {
                saveState(state => {
                    delete state.titles[entry.sessionId];
                    if (state.pinned) delete state.pinned[entry.sessionId];
                    for (const [key, saved] of Object.entries(state.workspaces)) if (saved.sessionId === entry.sessionId) delete state.workspaces[key];
                });
            } catch { warning = 'CLI 历史已删除，但清理本机标题失败；请检查磁盘后重试'; }
            panel._postMessage({ type: 'historyDeleted', sessionId: entry.sessionId });
            if (!quiet) panel._postMessage({ type: 'historyNotice', message: warning || '已删除对话：' + entry.title });
            return warning;
        } catch (error) {
            if (replacement && canRestore) {
                try {
                    const restored = await createProcess(manager, { sessionId: entry.sessionId, engine: entry.engine, title: entry.title, requestTimeoutMs: 10000 }, configure);
                    delete restored._kiroStartOptions.requestTimeoutMs;
                    showConversation(panel, restored);
                } catch { error.message += '；当前保留新对话，可从历史列表重新打开原记录'; }
            }
            throw error;
        }
    }

    async function deleteConversations(panel, entries) {
        const confirmation = await vscode.window.showWarningMessage('删除所选的 ' + entries.length + ' 个对话？',
            { modal: true, detail: '将永久删除这些本机 Kiro CLI 历史记录，无法撤销。包含当前对话时会自动打开新对话。\n\n' +
                entries.slice(0, 8).map(entry => '• ' + entry.title).join('\n') + (entries.length > 8 ? '\n另有 ' + (entries.length - 8) + ' 个对话' : '') }, '删除所选');
        if (confirmation !== '删除所选') return null;
        const result = { type: 'historyBatchResult', deleted: [], failures: [], warnings: [] };
        // Keep the current connection until the inactive selected sessions have been handled.
        const current = panel._cliManager._process?.sessionId;
        const ordered = [...entries].sort((a, b) => Number(a.sessionId === current) - Number(b.sessionId === current));
        for (let index = 0; index < ordered.length; index++) {
            const entry = ordered[index];
            panel._postMessage({ type: 'historyProgress', message: '正在删除 ' + (index + 1) + ' / ' + ordered.length + '…' });
            try {
                const warning = await deleteConversation(panel, entry, { confirmed: true, quiet: true });
                result.deleted.push(entry.sessionId);
                if (warning) result.warnings.push(warning);
            } catch (error) {
                result.failures.push({ sessionId: entry.sessionId, title: entry.title, message: error.message });
                if (error.stopBatch) {
                    for (const skipped of ordered.slice(index + 1)) result.failures.push({ sessionId: skipped.sessionId, title: skipped.title, message: '未执行：请先刷新列表确认上一条删除结果' });
                    break;
                }
            }
        }
        return result;
    }

    async function changeConversation(panel, sessionId) {
        if (panel._kiroHistoryBusy || panel._cliManager._process?._kiroTurnActive) return;
        panel._kiroHistoryBusy = true;
        panel._postMessage({ type: 'loading', active: true });
        try {
            const manager = panel._cliManager;
            const old = manager._process;
            let options;
            if (sessionId) {
                const entry = panel._kiroHistoryEntries?.get(sessionId);
                if (!entry) throw new Error('请刷新历史列表后重试');
                options = { sessionId, engine: entry.engine, title: entry.title };
            } else options = { engine: 'v3' };
            const model = old?.configOptions.find(option => option.id === 'model')?.currentValue;
            const effort = old?.configOptions.find(option => option.id === 'effortLevel')?.currentValue;
            const cli = sessionId === old?.sessionId ? old : await createProcess(manager, options, async candidate => {
                if (sessionId) return;
                if (model && candidate.configOptions.find(option => option.id === 'model')?.options.some(option => option.value === model)) {
                    await candidate.setConfigOption('model', model);
                }
                if (effort && candidate.configOptions.find(option => option.id === 'effortLevel')?.options.some(option => option.value === effort)) {
                    await candidate.setConfigOption('effortLevel', effort);
                }
            });
            showConversation(panel, cli);
            panel._postMessage({ type: 'historyRestored' });
        } catch (error) {
            panel._postMessage({ type: 'historyError', message: '打开对话失败：' + error.message });
        } finally {
            panel._kiroHistoryBusy = false;
            panel._postMessage({ type: 'loading', active: false });
        }
    }

    const handleUserMessage = ChatPanelProvider.prototype.handleUserMessage;
    ChatPanelProvider.prototype.handleUserMessage = async function (text, displayText = text) {
        try {
            const cli = await this._cliManager.ensureProcess();
            saveState(state => {
                if (!state.titles[cli.sessionId]) state.titles[cli.sessionId] = displayText.trim().replace(/\s+/g, ' ').slice(0, 100);
            });
            this._postMessage({ type: 'currentSession', sessionId: cli.sessionId, title: readState().titles[cli.sessionId] });
            return await handleUserMessage.call(this, text);
        } catch (error) { this._postMessage({ type: 'error', message: '连接失败：' + error.message }); }
    };

    const postMessage = ChatPanelProvider.prototype._postMessage;
    ChatPanelProvider.prototype._postMessage = function (message) {
        if (message.type === 'systemMessage' && message.message.startsWith('当前账户：')) this._kiroAccountMessage = message.message;
        return postMessage.call(this, message);
    };

    const onMessage = ChatPanelProvider.prototype._onWebviewMessage;
    ChatPanelProvider.prototype._onWebviewMessage = async function (message) {
        if (['renameHistory', 'pinHistory', 'exportHistory', 'deleteHistory', 'deleteHistoryBatch'].includes(message.type)) {
            if (this._kiroHistoryBusy || this._cliManager._process?._kiroTurnActive) return;
            const deleting = message.type === 'deleteHistory' || message.type === 'deleteHistoryBatch';
            if (deleting && (this._cliManager._kiroStarting || this._kiroCatalogRefreshing || this._kiroCatalogChecking || this._kiroCatalogPending || this._cliManager._process?._kiroChangePreparing)) {
                this._postMessage({ type: 'historyError', message: '请等待当前连接或模型操作完成后再删除' }); return;
            }
            this._kiroHistoryBusy = true;
            this._postMessage({ type: 'historyLoading', active: true });
            if (deleting) this._postMessage({ type: 'loading', active: true });
            let temporary, batchResult;
            try {
                const manager = this._cliManager;
                const entries = await listSessions(manager);
                if (message.type === 'deleteHistoryBatch') {
                    if (!Array.isArray(message.sessionIds) || !message.sessionIds.length || message.sessionIds.some(id => typeof id !== 'string')) throw new Error('请先选择要删除的对话');
                    const ids = new Set(message.sessionIds);
                    const selected = entries.filter(item => ids.has(item.sessionId));
                    if (selected.length !== ids.size) throw new Error('部分所选对话已不可用，请刷新列表后重新选择');
                    batchResult = await deleteConversations(this, selected);
                    await openHistory(this);
                    return;
                }
                const entry = entries.find(item => item.sessionId === message.sessionId);
                if (!entry) throw new Error('对话已不可用，请刷新历史列表');
                if (message.type === 'renameHistory') {
                    const title = await vscode.window.showInputBox({ title: '重命名 Kiro 对话', value: entry.title,
                        prompt: '仅修改本机显示标题', validateInput: value => !value.trim() || value.trim().length > 120 ? '请输入 1–120 个字符' : undefined });
                    if (title === undefined) return;
                    const clean = title.trim().replace(/\s+/g, ' ').slice(0, 120);
                    if (!clean) return;
                    saveState(state => { state.titles[entry.sessionId] = clean; });
                    if (manager._process?.sessionId === entry.sessionId) this._postMessage({ type: 'currentSession', sessionId: entry.sessionId, title: clean });
                } else if (message.type === 'pinHistory') {
                    saveState(state => { state.pinned ||= {}; if (state.pinned[entry.sessionId]) delete state.pinned[entry.sessionId]; else state.pinned[entry.sessionId] = true; });
                } else if (deleting) {
                    await deleteConversation(this, entry);
                } else {
                    const target = await vscode.window.showSaveDialog({ title: '导出 Kiro 对话',
                        defaultUri: vscode.Uri.file(path.join(os.homedir(), entry.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 70) + '.md')),
                        filters: { Markdown: ['md'] }, saveLabel: '导出 Markdown' });
                    if (!target) return;
                    let cli = manager._process;
                    if (cli?.sessionId !== entry.sessionId) {
                        const cliPath = manager.resolvedCliPath || await manager.resolveCliPath();
                        temporary = new CliProcess(cliPath, manager._getWorkspacePath(), { sessionId: entry.sessionId, engine: entry.engine, requestTimeoutMs: 10000 });
                        await temporary.initializeAndCreateSession(manager._getWorkspacePath());
                        cli = temporary;
                    }
                    const transcript = cli._kiroTranscript || [];
                    const markdown = '# ' + entry.title + '\n\n导出时间：' + new Date().toISOString() + '\n\n' +
                        transcript.map(item => '## ' + ({ user: '用户', assistant: 'Kiro', tool: '工具' }[item.role] || item.role) + '\n\n' + item.text).join('\n\n---\n\n') + '\n';
                    await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, 'utf8'));
                    this._postMessage({ type: 'historyNotice', message: '已导出 Markdown：' + path.basename(target.fsPath) });
                }
                await openHistory(this);
            } catch (error) { this._postMessage({ type: 'historyError', message: error.message }); }
            finally {
                temporary?.dispose(); this._kiroHistoryBusy = false;
                this._postMessage({ type: 'historyLoading', active: false });
                if (deleting) this._postMessage({ type: 'loading', active: false });
                if (batchResult) this._postMessage(batchResult);
            }
            return;
        }
        if (message.type === 'listHistory') return openHistory(this);
        if (message.type === 'resumeHistory') return changeConversation(this, message.sessionId);
        if (message.type === 'clearChat') return changeConversation(this);
        if (this._kiroHistoryBusy && ['sendMessage', 'selectModel', 'retry', 'startSpec'].includes(message.type)) return;
        if (message.type === 'ready') {
            await onMessage.call(this, message);
            if (this._cliManager._process?.sessionId) showConversation(this, this._cliManager._process);
            return;
        }
        return onMessage.call(this, message);
    };
};

exports.setupHistoryControls = function setupHistoryControls(api) {
    const button = document.getElementById('history-btn');
    const panel = document.getElementById('history-panel');
    const list = document.getElementById('history-list');
    const search = document.getElementById('history-search');
    const status = document.getElementById('history-status');
    const title = document.getElementById('conversation-title');
    let sessions = [], current = '', busy = true;

    function render() {
        list.innerHTML = '';
        const query = search.value.trim().toLowerCase();
        const matches = sessions.filter(session => (session.title + ' ' + session.sessionId).toLowerCase().includes(query));
        for (const session of matches) {
            const item = document.createElement('button');
            item.className = 'history-item' + (session.sessionId === current ? ' active' : '');
            item.disabled = busy;
            item.title = session.title;
            const label = document.createElement('span');
            label.className = 'history-item-title';
            label.textContent = session.title;
            const detail = document.createElement('span');
            detail.className = 'history-item-detail';
            detail.textContent = new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false }) +
                (session.messageCount !== undefined ? ' · ' + session.messageCount + ' 条消息' : '') +
                (session.sessionId === current ? ' · 当前' : '');
            item.appendChild(label);
            item.appendChild(detail);
            item.addEventListener('click', () => {
                if (busy) return;
                status.textContent = '正在恢复对话…';
                api.postMessage({ type: 'resumeHistory', sessionId: session.sessionId });
            });
            list.appendChild(item);
        }
        if (!matches.length) status.textContent = query ? '没有匹配的对话' : '当前工作区还没有历史对话';
        else status.textContent = matches.length + ' 个对话 · 当前工作区';
    }
    function refresh() { api.postMessage({ type: 'listHistory' }); }
    function close() { panel.classList.add('hidden'); button.setAttribute('aria-expanded', 'false'); }
    button.addEventListener('click', () => {
        if (panel.classList.contains('hidden')) {
            panel.classList.remove('hidden'); button.setAttribute('aria-expanded', 'true'); search.focus(); refresh();
        }
        else close();
    });
    document.getElementById('history-refresh').addEventListener('click', refresh);
    document.getElementById('history-close').addEventListener('click', close);
    search.addEventListener('input', render);
    search.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'historyList') {
            sessions = message.sessions; current = message.currentSessionId || ''; render();
        } else if (message.type === 'historyLoading') {
            document.getElementById('history-refresh').disabled = !!message.active;
            if (message.active) status.textContent = '正在读取历史…';
        } else if (message.type === 'historyError') {
            panel.classList.remove('hidden'); button.setAttribute('aria-expanded', 'true'); status.textContent = message.message;
        } else if (message.type === 'historyRestored') close();
        else if (message.type === 'currentSession') {
            current = message.sessionId; title.textContent = message.title; title.title = message.title;
        } else if (message.type === 'loading') {
            busy = !!message.active;
            document.getElementById('clear-chat-btn').disabled = busy;
            for (const item of list.children) item.disabled = busy;
        }
    });
};
