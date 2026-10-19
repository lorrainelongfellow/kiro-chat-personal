'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');


exports.install = function install({ CliManager, vscode }) {
    const resolveCliPath = CliManager.prototype.resolveCliPath;
    CliManager.prototype.resolveCliPath = async function () {
        if (this._options?.cliPath) return resolveCliPath.call(this);
        const configured = vscode.workspace.getConfiguration('kiroPersonal').get('cliPath', '').trim();
        if (configured && !fs.existsSync(configured)) throw new Error('设置中的 Kiro CLI 路径不存在：' + configured);
        const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        const candidates = configured ? [configured] : process.platform === 'win32' ?
            [path.join(local, 'Kiro-Cli', 'kiro-cli.exe'), path.join(os.homedir(), '.local', 'bin', 'kiro-cli.exe')] :
            [path.join(os.homedir(), '.local', 'bin', 'kiro-cli')];
        const cliPath = candidates.find(candidate => fs.existsSync(candidate));
        if (!cliPath) return resolveCliPath.call(this);
        this._resolvedCliPath = cliPath;
        this._setState({ status: 'ready', cliPath });
        return cliPath;
    };

    require('./kiro-chat-management.js').installLogin({ CliManager, vscode });
};
