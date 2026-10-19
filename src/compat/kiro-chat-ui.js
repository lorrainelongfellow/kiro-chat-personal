'use strict';

const path = require('node:path');

function autoAllow(cli) {
    return !!cli.sessionId && cli._kiroPermissionSession === cli.sessionId;
}
function onceOption(request) {
    return request.options?.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string');
}
function currentRequest(cli, request) {
    return !request.sessionId || request.sessionId === cli.sessionId;
}
function answer(cli, id, option) {
    cli._writeToStdin({ jsonrpc: '2.0', id, result: { outcome: option ?
        { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
}
function publishPolicy(panel) {
    const cli = panel._cliManager._process;
    panel._postMessage({ type: 'permissionPolicy', sessionId: cli?.sessionId || '', enabled: !!cli && autoAllow(cli) });
}

exports.install = function install({ CliProcess, ChatPanelProvider, vscode }) {
    const webviewContent = ChatPanelProvider.prototype._getWebviewContent;
    ChatPanelProvider.prototype._getWebviewContent = function () {
        const vendor = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'vendor');
        return webviewContent.call(this)
            .replaceAll('{{ideStylesUri}}', this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'ide.css')).toString())
            .replaceAll('{{ideScriptUri}}', this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'ide-main.js')).toString())
            .replaceAll('{{managementScriptUri}}', this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'ide-management.js')).toString())
            .replaceAll('{{markedUri}}', this._panel.webview.asWebviewUri(vscode.Uri.joinPath(vendor, 'marked.js')).toString())
            .replaceAll('{{purifyUri}}', this._panel.webview.asWebviewUri(vscode.Uri.joinPath(vendor, 'purify.js')).toString());
    };
    const parseConfigOptions = CliProcess.prototype._parseConfigOptions;
    CliProcess.prototype._parseConfigOptions = function (result) {
        if (result?.modes) this._kiroModes = result.modes;
        const options = parseConfigOptions.call(this, result).map(option => {
            const raw = result?.configOptions?.find(item => item.id === option.id);
            return {
                ...raw, ...option,
                options: option.options.map(choice => {
                    const source = raw?.options?.find(item => item.value === choice.value) ||
                        (option.id === 'model' ? result?.models?.availableModels?.find(item => item.modelId === choice.value) : null);
                    return { ...source, ...choice };
                }),
            };
        });
        const modes = this._kiroModes;
        if (!options.some(option => option.id === 'mode') && modes?.availableModes?.length) {
            options.push({ id: 'mode', category: 'mode', name: 'Mode', currentValue: modes.currentModeId,
                options: modes.availableModes.map(mode => ({ value: mode.id, name: mode.name, description: mode.description || '' })) });
        }
        return options;
    };

    const setConfigOption = CliProcess.prototype.setConfigOption;
    CliProcess.prototype.setConfigOption = async function (configId, value) {
        if (configId === 'mode' && this._kiroEngine !== 'v3') {
            const mode = this.configOptions.find(option => option.id === 'mode');
            if (!mode?.options.some(option => option.value === value)) throw new Error('此会话不支持该模式');
            await this._sendRaw({ jsonrpc: '2.0', id: this._nextId(), method: 'session/set_mode',
                params: { sessionId: this.sessionId, modeId: value } });
            this._configOptions = this.configOptions.map(option => option.id === 'mode' ? { ...option, currentValue: value } : option);
            return this.configOptions;
        }
        const offered = this.configOptions.find(option => option.id === configId);
        if (!offered?.options.some(option => option.value === value)) throw new Error('当前会话未提供该选项');
        return setConfigOption.call(this, configId, value);
    };

    const incomingRequest = CliProcess.prototype._handleIncomingRequest;
    CliProcess.prototype._handleIncomingRequest = function (id, method, params) {
        if (method !== 'session/request_permission') return incomingRequest.call(this, id, method, params);
        if (this._kiroPermissionCancelling) {
            answer(this, id, null);
            return;
        }
        const allowed = onceOption(params || {});
        if (autoAllow(this) && allowed && currentRequest(this, params || {})) {
            answer(this, id, allowed);
            return;
        }
        this._kiroPermissions ||= new Map();
        this._kiroPermissions.set(String(id), { ...params, _kiroRequestId: id });
        this._kiroOnPermission?.({ requestId: String(id), sessionId: this.sessionId,
            title: params?.toolCall?.title || '工具操作需要确认',
            allowConversation: currentRequest(this, params || {}),
            options: (params?.options || []).filter(option => ['allow_once', 'reject_once'].includes(option.kind)) });
    };

    const sendPrompt = CliProcess.prototype.sendPrompt;
    CliProcess.prototype.sendPrompt = async function (text, onUpdate) {
        this._kiroPermissionCancelling = false;
        this._kiroOnTurnState?.(true);
        try {
            return await sendPrompt.call(this, text, update => {
                if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
                    const detail = update.rawInput ?? update.content?.filter?.(part => part.type === 'text').map(part => part.text).join('\n');
                    this._kiroOnToolEvent?.({ id: update.toolCallId, title: update.title, status: update.status,
                        kind: update.kind, detail: typeof detail === 'string' ? detail.slice(0,12000) : detail ? JSON.stringify(detail,null,2).slice(0,12000) : '' });
                }
                onUpdate(update);
            });
        }
        finally { this._kiroOnTurnState?.(false); }
    };

    function wire(panel) {
        const cli = panel._cliManager._process;
        if (!cli) return;
        cli._kiroOnTurnState = active => panel._postMessage({ type: 'turnState', active });
        cli._kiroOnToolEvent = event => panel._postMessage({ type: 'toolEvent', ...event });
        cli._kiroOnPermission = request => panel._postMessage({ type: 'permissionRequest', ...request });
        publishPolicy(panel);
        const editor = panel._lastActiveTextEditor;
        panel._postMessage({ type: 'editorContext', available: !!editor && !editor.document.isClosed,
            name: editor ? path.basename(editor.document.fileName || editor.document.uri.fsPath) : '',
            included: panel._kiroUseEditorContext !== false,
            workspace: path.basename(panel._cliManager._getWorkspacePath()) });
    }

    const buildContext = ChatPanelProvider.prototype._buildContextEnrichedPrompt;
    ChatPanelProvider.prototype._buildContextEnrichedPrompt = function (text) {
        return this._kiroUseEditorContext === false ? text : buildContext.call(this, text);
    };

    const postMessage = ChatPanelProvider.prototype._postMessage;
    ChatPanelProvider.prototype._postMessage = function (message) {
        if (message.type === 'configOptions' || message.type === 'restoreConversation') {
            // Wire the newly adopted process before a user can submit a prompt.
            wire(this);
        }
        if (message.type === 'accountDisconnected') publishPolicy(this);
        return postMessage.call(this, message);
    };

    const onMessage = ChatPanelProvider.prototype._onWebviewMessage;
    ChatPanelProvider.prototype._onWebviewMessage = async function (message) {
        try {
            if (message.type === 'cancelPrompt') {
                const cli = this._cliManager._process;
                if (cli) {
                    cli._kiroPermissionCancelling = true;
                    for (const [requestId, request] of cli._kiroPermissions || []) {
                        answer(cli, request._kiroRequestId, null);
                        cli._kiroPermissions.delete(requestId);
                        this._postMessage({ type: 'permissionResolved', sessionId: cli.sessionId, requestId });
                    }
                }
                if (cli?._kiroTurnActive) cli._writeToStdin({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: cli.sessionId } });
                return;
            }
            if (message.type === 'revokeConversationPermission') {
                const cli = this._cliManager._process;
                if (cli && cli.sessionId === message.sessionId) cli._kiroPermissionSession = null;
                publishPolicy(this);
                return;
            }
            if (message.type === 'permissionResponse') {
                const cli = this._cliManager._process;
                if (!cli || cli.sessionId !== message.sessionId) return;
                const request = cli._kiroPermissions?.get(message.requestId);
                if (!request) return;
                const option = request.options?.find(item => item.optionId === message.optionId && ['allow_once', 'reject_once'].includes(item.kind));
                if (message.optionId && !option) throw new Error('无效的工具确认选项');
                if (message.allowConversation === true) {
                    if (option?.kind !== 'allow_once') throw new Error('仅允许选项可开启本对话自动确认');
                    if (!currentRequest(cli, request)) throw new Error('此请求需单独确认');
                    cli._kiroPermissionSession = cli.sessionId;
                }
                answer(cli, request._kiroRequestId, option);
                cli._kiroPermissions.delete(message.requestId);
                this._postMessage({ type: 'permissionResolved', sessionId: cli.sessionId, requestId: message.requestId });
                if (autoAllow(cli)) {
                    for (const [requestId, pending] of cli._kiroPermissions) {
                        const allowed = onceOption(pending);
                        if (!allowed || !currentRequest(cli, pending)) continue;
                        answer(cli, pending._kiroRequestId, allowed);
                        cli._kiroPermissions.delete(requestId);
                        this._postMessage({ type: 'permissionResolved', sessionId: cli.sessionId, requestId });
                    }
                }
                publishPolicy(this);
                return;
            }
            if (message.type === 'attachFiles') {
                const files = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: '添加到对话' });
                if (!files) return;
                this._kiroAttachments ||= new Set();
                for (const file of files) this._kiroAttachments.add(file.fsPath);
                this._postMessage({ type: 'attachedFiles', files: files.map(file => ({ path: file.fsPath, name: path.basename(file.fsPath) })) });
                return;
            }
            if (message.type === 'editorContext') {
                this._kiroUseEditorContext = !!message.included;
                wire(this);
                return;
            }
            if (message.type === 'sendMessage') {
                if (this._kiroHistoryBusy || this._cliManager._process?._kiroTurnActive) return;
                const files = (message.attachments || []).filter(file => typeof file === 'string' && this._kiroAttachments?.has(file));
                const text = String(message.text || '').trim();
                if (!text && !files.length) return;
                const body = text + (files.length ? '\n\n[User attached files]\n' + files.map(file => JSON.stringify(file)).join('\n') : '');
                await this.handleUserMessage(body, text || '查看附加文件');
                return;
            }
            const result = await onMessage.call(this, message);
            if (message.type === 'ready') {
                wire(this);
                const cli = this._cliManager._process;
                if (cli?._kiroTurnActive) this._postMessage({ type: 'turnState', active: true });
                for (const [requestId, request] of cli?._kiroPermissions || []) {
                    cli._kiroOnPermission?.({ requestId, sessionId: cli.sessionId,
                        title: request.toolCall?.title || '工具操作需要确认',
                        allowConversation: currentRequest(cli, request),
                        options: (request.options || []).filter(option => ['allow_once', 'reject_once'].includes(option.kind)) });
                }
            }
            return result;
        } catch (error) {
            this._postMessage({ type: 'error', message: error.message });
        }
    };
};
