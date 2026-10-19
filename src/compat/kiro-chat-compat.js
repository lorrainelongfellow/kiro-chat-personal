'use strict';

// Local compatibility fix for Kiro Chat 0.1.3 and the installed Kiro CLI.
// Both ACP model formats are converted to the webview's existing format.
const { execFile } = require('node:child_process');
const effortNames = { low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
let installed = false;

exports.install = function install({ CliProcess, CliManager, ChatPanelProvider, vscode }) {
    if (installed) return;
    installed = true;

    // Reuse the existing chat handlers in a secondary-sidebar WebviewView.
    const setSpecCallbacks = ChatPanelProvider.prototype.setSpecCallbacks;
    ChatPanelProvider.prototype.setSpecCallbacks = function (...callbacks) {
        setSpecCallbacks.apply(this, callbacks);
        this._disposables.push(vscode.window.registerWebviewViewProvider('kiroPersonal.chatView', {
            resolveWebviewView: view => {
                view.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
                const panel = { webview: view.webview, dispose() {} };
                this._panel = panel;
                view.webview.onDidReceiveMessage(message => this._onWebviewMessage(message), undefined, this._disposables);
                view.onDidDispose(() => {
                    if (this._panel === panel) this._panel = undefined;
                }, undefined, this._disposables);
                view.webview.html = this._getWebviewContent();
            },
        }, { webviewOptions: { retainContextWhenHidden: true } }));
    };
    ChatPanelProvider.prototype.openPanel = function () {
        return vscode.commands.executeCommand('kiroPersonal.chatView.focus');
    };
    const handleSpecPrompt = ChatPanelProvider.prototype.handleSpecPrompt;
    ChatPanelProvider.prototype.handleSpecPrompt = async function (...args) {
        await this.openPanel();
        return handleSpecPrompt.apply(this, args);
    };

    const parseConfigOptions = CliProcess.prototype._parseConfigOptions;
    CliProcess.prototype._parseConfigOptions = function (result) {
        const options = parseConfigOptions.call(this, result);
        if (options.length) {
            this._kiroModelApi = 'config';
            return options.map(option => option.id === 'effortLevel' ? {
                ...option,
                options: option.options.map(level => ({ ...level, name: effortNames[level.value] || level.name })),
            } : option);
        }
        if (!result?.models?.availableModels) return options;
        this._kiroModelApi = 'legacy';
        return [{
            id: 'model',
            name: 'Model',
            description: '',
            category: 'model',
            currentValue: result.models.currentModelId || 'auto',
            options: result.models.availableModels.map(model => ({
                value: model.modelId,
                name: model.name || model.modelId,
                description: model.description || '',
            })),
        }];
    };

    CliProcess.prototype.refreshEffortOptions = async function () {
        if (this._kiroModelApi !== 'legacy') return this._configOptions;
        const response = await this._sendRaw({
            jsonrpc: '2.0',
            id: this._nextId(),
            method: '_kiro.dev/commands/execute',
            params: { sessionId: this._sessionId, command: { command: 'effort', args: {} } },
        });
        this._configOptions = this._configOptions.filter(option => option.id !== 'effortLevel');
        const levels = response.result?.message?.match(/Available effort levels:\s*(.+)/);
        if (!response.result?.success || !levels) return this._configOptions;
        this._configOptions.push({
            id: 'effortLevel',
            name: '思考强度',
            category: 'thought_level',
            currentValue: this._kiroEffortValue || '',
            options: levels[1].split(',').map(value => value.trim()).filter(Boolean)
                .map(value => ({ value, name: effortNames[value] || value })),
        });
        return this._configOptions;
    };

    const initializeSession = CliProcess.prototype.initializeAndCreateSession;
    CliProcess.prototype.initializeAndCreateSession = async function (workspacePath) {
        const session = await initializeSession.call(this, workspacePath);
        await this.refreshEffortOptions();
        return session;
    };

    const setConfigOption = CliProcess.prototype.setConfigOption;
    CliProcess.prototype.setConfigOption = async function (configId, value) {
        if (this._kiroModelApi === 'legacy' && configId === 'effortLevel') {
            const effort = this._configOptions.find(option => option.id === 'effortLevel');
            if (!effort?.options.some(option => option.value === value)) {
                throw new Error('The current model does not support this effort level: ' + value);
            }
            const response = await this._sendRaw({
                jsonrpc: '2.0',
                id: this._nextId(),
                method: '_kiro.dev/commands/execute',
                params: {
                    sessionId: this._sessionId,
                    command: { command: 'effort', args: { level: value } },
                },
            });
            if (!response.result?.success) throw new Error(response.result?.message || 'Effort change failed');
            this._kiroEffortValue = value;
            this._configOptions = this._configOptions.map(option =>
                option.id === 'effortLevel' ? { ...option, currentValue: value } : option);
            return this._configOptions;
        }
        if (this._kiroModelApi !== 'legacy' || configId !== 'model') {
            return setConfigOption.call(this, configId, value);
        }
        const model = this._configOptions.find(option => option.id === 'model');
        if (!model?.options.some(option => option.value === value)) {
            throw new Error('The current session does not list this model: ' + value);
        }
        await this._sendRaw({
            jsonrpc: '2.0',
            id: this._nextId(),
            method: 'session/set_model',
            params: { sessionId: this._sessionId, modelId: value },
        });
        this._configOptions = this._configOptions.map(option =>
            option.id === 'model' ? { ...option, currentValue: value } : option);
        this._kiroEffortValue = '';
        return this.refreshEffortOptions();
    };

    ChatPanelProvider.prototype._handleModelSelection = async function (configId, value) {
        let cli;
        this._postMessage({ type: 'loading', active: true });
        try {
            cli = await this._cliManager.ensureProcess();
            const options = await cli.setConfigOption(configId, value);
            const name = options.find(option => option.id === configId)?.options
                .find(option => option.value === value)?.name || value;
            this._postMessage({ type: 'configOptions', options });
            this._postMessage({
                type: 'systemMessage',
                message: ({ effortLevel: '思考强度：', model: '当前模型：', mode: '当前模式：', autopilot: '执行方式：' }[configId] || '设置：') + name,
            });
        } catch (error) {
            if (cli) this._postMessage({ type: 'configOptions', options: cli.configOptions });
            this._postMessage({ type: 'error', message: '设置失败：' + error.message });
        } finally {
            this._postMessage({ type: 'loading', active: false });
        }
    };

    const onWebviewMessage = ChatPanelProvider.prototype._onWebviewMessage;
    ChatPanelProvider.prototype._onWebviewMessage = function (message) {
        if (message.type === 'ready') return loadModels(this);
        if (message.type === 'clearChat') return newConversation(this);
        return onWebviewMessage.call(this, message);
    };
    require('./kiro-chat-history.js').install({ CliProcess, CliManager, ChatPanelProvider, vscode });
    require('./kiro-chat-ui.js').install({ CliProcess, ChatPanelProvider, vscode });
    require('./kiro-chat-images.js').install({ CliProcess, ChatPanelProvider });
    require('./kiro-chat-usage.js').install({ CliProcess, ChatPanelProvider });
    require('./kiro-chat-models.js').install({ CliProcess, ChatPanelProvider });
    require('./kiro-chat-management.js').install({ CliManager, ChatPanelProvider, vscode });
    require('./kiro-chat-changes.js').install({ CliProcess, ChatPanelProvider, vscode });
    require('./kiro-personal.js').install({ CliManager, vscode });
};

async function loadModels(panel, selectedModel, selectedEffort) {
    panel._postMessage({ type: 'loading', active: true });
    try {
        const cli = await panel._cliManager.ensureProcess();
        if (selectedModel && cli.configOptions.some(option =>
            option.id === 'model' && option.options.some(model => model.value === selectedModel))) {
            await cli.setConfigOption('model', selectedModel);
        }
        if (selectedEffort && cli.configOptions.some(option =>
            option.id === 'effortLevel' && option.options.some(level => level.value === selectedEffort))) {
            await cli.setConfigOption('effortLevel', selectedEffort);
        }
        panel._postMessage({ type: 'configOptions', options: cli.configOptions });
        const account = await readAccount(panel._cliManager.resolvedCliPath);
        panel._postMessage({
            type: 'systemMessage',
            message: account ? '当前账户：' + account : 'Kiro 已连接，请选择模型并开始聊天。',
        });
    } catch (error) {
        panel._postMessage({ type: 'error', message: '连接失败：' + error.message });
    } finally {
        panel._postMessage({ type: 'loading', active: false });
    }
}

async function newConversation(panel) {
    const selected = panel._cliManager._process?.configOptions
        .find(option => option.id === 'model')?.currentValue;
    const effort = panel._cliManager._process?.configOptions
        .find(option => option.id === 'effortLevel')?.currentValue;
    panel._postMessage({ type: 'loading', active: true });
    try {
        await panel._cliManager.restartProcess();
        panel._postMessage({ type: 'clearChat' });
        await loadModels(panel, selected, effort);
    } catch (error) {
        panel._postMessage({ type: 'error', message: '新建会话失败：' + error.message });
    } finally {
        panel._postMessage({ type: 'loading', active: false });
    }
}

function readAccount(cliPath) {
    return new Promise(resolve => {
        execFile(cliPath, ['whoami', '--format', 'json'], { timeout: 10000 }, (error, stdout) => {
            if (error) return resolve(null);
            try {
                resolve(JSON.parse(stdout).email || null);
            } catch {
                resolve(null);
            }
        });
    });
}

// Bundled into the existing webview script so the VS Code API stays private.
exports.setupEffortControls = function setupEffortControls(api) {
    const selector = document.getElementById('effort-selector');
    let busy = true;
    let available = false;
    let configId = 'effortLevel';

    function addOption(value, name, disabled) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = name;
        option.disabled = !!disabled;
        selector.appendChild(option);
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'configOptions') {
            const effort = message.options.find(option => option.id === 'effortLevel' || option.category === 'thought_level');
            const model = message.options.find(option => option.id === 'model');
            selector.innerHTML = '';
            available = !!effort?.options.length;
            if (available) {
                configId = effort.id;
                if (!effort.currentValue) addOption('', '默认', true);
                for (const option of effort.options) addOption(option.value, option.name);
                selector.value = effort.currentValue;
                selector.title = '思考强度：等级越高，通常耗时和用量越多';
            } else {
                addOption('', model?.currentValue === 'auto' ? '自动' : '不支持');
                selector.value = '';
                selector.title = '当前模型不支持手动设置思考强度';
            }
            selector.disabled = busy || !available;
        } else if (message.type === 'loading') {
            busy = !!message.active;
            selector.disabled = busy || !available;
        }
    });

    selector.addEventListener('change', () => {
        if (busy || !available || !selector.value) return;
        selector.disabled = true;
        api.postMessage({ type: 'selectModel', configId, value: selector.value });
    });
};
