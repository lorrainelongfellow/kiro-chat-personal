'use strict';

// Per-turn snapshots, never a background scan. Git supplies clean-file baselines;
// already dirty files are captured before the prompt so older edits stay separate.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const limit = 1024 * 1024, fileLimit = 200, textBudget = 16 * limit;
const reviewScheme = 'kiro-review-' + createHash('sha256').update(__dirname).digest('hex').slice(0, 8);

function git(cwd, args, binary = false) {
    return new Promise((resolve, reject) => execFile('git', ['--no-optional-locks', ...args], {
        cwd, windowsHide: true, timeout: 10000, maxBuffer: 8 * limit, encoding: binary ? 'buffer' : 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function inside(root, file) {
    const relative = path.relative(root, file);
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function eligible(batch, input) {
    try {
        const file = path.resolve(batch.cwd, input.startsWith('file:') ? fileURLToPath(input) : input);
        if (!inside(batch.cwd, file)) return null;
        // Never follow a workspace symlink outside the selected workspace.
        if (fs.existsSync(file) && (!fs.statSync(file).isFile() || !inside(batch.cwd, fs.realpathSync(file)))) return null;
        return file;
    } catch { return null; }
}
function decode(buffer) {
    if (buffer.length >= 2 && buffer[0] === 255 && buffer[1] === 254) return buffer.subarray(2).toString('utf16le');
    if (buffer.includes(0)) return null;
    for (const encoding of ['utf-8', 'gb18030']) {
        try { return new TextDecoder(encoding, { fatal: true }).decode(buffer); } catch { /* Try legacy source encoding. */ }
    }
    return null;
}
function fromBuffer(batch, buffer) {
    if (buffer.length > limit || batch.bytes + buffer.length > textBudget) return { exists: true, unavailable: '文件较大，未保留文本快照' };
    batch.bytes += buffer.length;
    const text = decode(buffer);
    return { exists: true, hash: createHash('sha256').update(buffer).digest('hex'), text, unavailable: text === null ? '二进制或不支持的文本编码' : '' };
}
function snapshot(batch, file) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > limit || batch.bytes + stat.size > textBudget) return { exists: true, unavailable: '文件较大，未保留文本快照', stamp: stat.size + ':' + stat.mtimeMs };
        return fromBuffer(batch, fs.readFileSync(file));
    } catch (error) { return error.code === 'ENOENT' ? { exists: false, text: '', hash: 'absent' } : { exists: true, unavailable: '读取文件失败' }; }
}
function statusPaths(output, root) {
    const parts = output.split('\0'), files = [];
    for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        const status = parts[i].slice(0, 2);
        files.push(path.resolve(root, parts[i].slice(3)));
        if (/[RC]/.test(status) && parts[i + 1]) files.push(path.resolve(root, parts[++i]));
    }
    return files;
}
async function begin(cwd, sessionId) {
    const batch = { id: randomUUID(), cwd: path.resolve(cwd), sessionId, startedAt: Date.now(), bytes: 0,
        before: new Map(), candidates: new Set(), reported: new Set(), snippets: new Map(), files: [], warnings: [] };
    try {
        batch.root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
        batch.head = (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim();
        batch.dirty = new Set(statusPaths(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), batch.root));
        for (const input of batch.dirty) {
            const file = eligible(batch, input); if (!file) continue;
            if (batch.before.size >= fileLimit) { batch.warnings.push('开始前改动文件超过 200 个，部分文件不提供精确快照'); break; }
            batch.before.set(file, snapshot(batch, file)); batch.candidates.add(file);
        }
    } catch {
        batch.root = null; batch.head = null;
        batch.warnings.push('当前工作区没有可用 Git 基线，仅收集 CLI 报告的文件改动');
    }
    return batch;
}
function observe(batch, tool) {
    if (!batch || !tool) return;
    const editing = ['edit', 'delete', 'move'].includes(tool.kind) || /write|edit|patch|create|delete|replace|remove|move|写入|修改|删除/i.test(tool.title || '');
    const paths = [];
    if (editing) {
        for (const location of tool.locations || []) if (typeof location.path === 'string') paths.push(location.path);
        const input = tool.rawInput;
        if (input && typeof input === 'object') for (const key of ['path', 'filePath', 'file_path', 'filename', 'old_path', 'new_path']) if (typeof input[key] === 'string') paths.push(input[key]);
    }
    for (const content of tool.content || []) if (content.type === 'diff' && typeof content.path === 'string') {
        paths.push(content.path);
        const file = eligible(batch, content.path);
        if (file && typeof content.newText === 'string' && content.newText.length < limit && (content.oldText || '').length < limit) {
            const previous = batch.snippets.get(file);
            batch.snippets.set(file, { oldText: previous?.oldText ?? content.oldText ?? '', newText: content.newText });
        }
    }
    for (const input of paths.slice(0, fileLimit)) {
        const file = eligible(batch, input);
        if (!file || batch.candidates.size >= fileLimit) continue;
        batch.candidates.add(file); batch.reported.add(file);
        if (!batch.root && !batch.before.has(file) && tool.status !== 'completed' && !batch.snippets.has(file)) batch.before.set(file, snapshot(batch, file));
    }
}
async function finish(batch) {
    if (batch.root) {
        try {
            const [status, changed] = await Promise.all([
                git(batch.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
                git(batch.cwd, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', batch.head, '--']),
            ]);
            for (const input of [...statusPaths(status, batch.root), ...changed.split('\0').filter(Boolean).map(file => path.resolve(batch.root, file))]) {
                const file = eligible(batch, input); if (file) batch.candidates.add(file);
            }
        } catch { batch.warnings.push('Git 结束状态查询失败，列表可能不完整'); }
    }
    if (batch.candidates.size > fileLimit) batch.warnings.push('本轮涉及文件超过 200 个，仅列出前 200 个');
    for (const file of [...batch.candidates].slice(0, fileLimit)) {
        let before = batch.before.get(file);
        if (!before && batch.root && !batch.dirty.has(file)) {
            try { before = fromBuffer(batch, await git(batch.root, ['show', batch.head + ':' + path.relative(batch.root, file).replaceAll('\\', '/')], true)); }
            catch { before = { exists: false, text: '', hash: 'absent' }; }
        }
        const after = snapshot(batch, file), snippet = batch.snippets.get(file);
        if (before?.hash && before.hash === after.hash) continue;
        if (before?.stamp && before.stamp === after.stamp && !batch.reported.has(file)) continue;
        const full = typeof before?.text === 'string' && typeof after.text === 'string';
        batch.files.push({ id: String(batch.files.length), path: file, name: path.relative(batch.cwd, file),
            status: !before ? 'reported' : !before.exists ? 'added' : !after.exists ? 'deleted' : 'modified',
            source: batch.reported.has(file) ? 'CLI 工具涉及' : '本轮期间工作区变化',
            before: full ? before.text : snippet?.oldText, after: full ? after.text : snippet?.newText,
            diffKind: full ? 'full' : snippet ? 'snippet' : 'unavailable',
            detail: full ? '' : snippet ? 'CLI 提供的差异片段' : before?.unavailable || after.unavailable || '未获取修改前快照' });
    }
    batch.finishedAt = Date.now();
    delete batch.before; delete batch.candidates; delete batch.snippets; delete batch.dirty; delete batch.reported;
    return batch;
}

exports.install = function install({ CliProcess, ChatPanelProvider, vscode }) {
    const batches = new Map(), documents = new Map();
    let provider;
    function publish(panel) {
        const cli = panel._cliManager._process, batch = cli?._kiroChangeBatch || batches.get(cli?.sessionId);
        panel._postMessage({ type: 'turnChanges', batch: batch ? { id: batch.id, sessionId: batch.sessionId, startedAt: batch.startedAt,
            finishedAt: batch.finishedAt, warnings: batch.warnings, files: batch.files.map(({ before, after, ...metadata }) => metadata) } : null });
    }
    const processLine = CliProcess.prototype._processLine;
    CliProcess.prototype._processLine = function (line) {
        if (this._kiroChangeBatch) {
            try {
                const message = JSON.parse(line);
                if (message.method === 'session/request_permission') observe(this._kiroChangeBatch, message.params?.toolCall);
                else if (message.method === 'session/update' && ['tool_call', 'tool_call_update'].includes(message.params?.update?.sessionUpdate)) observe(this._kiroChangeBatch, message.params.update);
            } catch { /* Normal non-JSON log lines are handled by the CLI adapter. */ }
        }
        return processLine.call(this, line);
    };
    const sendPrompt = CliProcess.prototype.sendPrompt;
    CliProcess.prototype.sendPrompt = async function (...args) {
        if (this._kiroChangePreparing || this._kiroChangeBatch || this._kiroTurnActive) throw new Error('当前对话正在生成回复');
        this._kiroChangePreparing = true;
        try { this._kiroChangeBatch = await begin(this._kiroWorkspacePath, this.sessionId); }
        finally { this._kiroChangePreparing = false; }
        this._kiroOnChanges?.();
        try { return await sendPrompt.apply(this, args); }
        finally {
            const batch = this._kiroChangeBatch; this._kiroChangeBatch = null;
            try {
                batches.set(this.sessionId, await finish(batch));
                while (batches.size > 5) batches.delete(batches.keys().next().value);
            } catch { batch.files = []; batch.warnings.push('本轮改动汇总失败，可在 VS Code 源代码管理中查看'); batches.set(this.sessionId, batch); }
            this._kiroOnChanges?.();
        }
    };
    const postMessage = ChatPanelProvider.prototype._postMessage;
    ChatPanelProvider.prototype._postMessage = function (message) {
        if (message.type === 'historyDeleted') {
            const batch = batches.get(message.sessionId);
            if (batch) for (const key of documents.keys()) if (key.includes('?id=' + batch.id + '-')) documents.delete(key);
            batches.delete(message.sessionId);
        }
        if (message.type === 'configOptions' || message.type === 'currentSession') {
            const cli = this._cliManager._process;
            if (cli) cli._kiroOnChanges = () => publish(this);
        }
        const result = postMessage.call(this, message);
        if (message.type === 'currentSession') publish(this);
        return result;
    };
    const onMessage = ChatPanelProvider.prototype._onWebviewMessage;
    ChatPanelProvider.prototype._onWebviewMessage = async function (message) {
        try {
            if (message.type === 'listTurnChanges') { publish(this); return; }
            if (message.type === 'openTurnFile' || message.type === 'openTurnDiff') {
                const batch = batches.get(this._cliManager._process?.sessionId);
                const file = batch?.id === message.batchId && batch.files.find(item => item.id === message.fileId);
                if (!file) throw new Error('改动列表已变化，请重新打开本轮改动');
                if (message.type === 'openTurnFile') {
                    if (!eligible(batch, file.path)) throw new Error('文件已删除或不在当前工作区');
                    await vscode.window.showTextDocument(vscode.Uri.file(file.path), { preview: true }); return;
                }
                if (file.diffKind === 'unavailable') throw new Error(file.detail);
                if (!provider) {
                    provider = vscode.workspace.registerTextDocumentContentProvider(reviewScheme, { provideTextDocumentContent: uri => documents.get(uri.toString()) || '' });
                    this._disposables.push({ dispose: () => { provider?.dispose(); provider = null; documents.clear(); } });
                }
                const oldUri = vscode.Uri.parse(reviewScheme + ':/before/' + encodeURIComponent(path.basename(file.path)) + '?id=' + batch.id + '-' + file.id);
                const newUri = vscode.Uri.parse(reviewScheme + ':/after/' + encodeURIComponent(path.basename(file.path)) + '?id=' + batch.id + '-' + file.id);
                documents.set(oldUri.toString(), file.before); documents.set(newUri.toString(), file.after);
                while (documents.size > 100) documents.delete(documents.keys().next().value);
                await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, file.name + (file.diffKind === 'snippet' ? '（CLI 差异片段）' : '（本轮开始前 ↔ 结束后）'), { preview: true });
                return;
            }
            return await onMessage.call(this, message);
        } catch (error) { this._postMessage({ type: 'managementNotice', message: error.message }); }
    };
};

// Reused by the isolated filesystem verification, without invoking a model.
exports.begin = begin;
exports.observe = observe;
exports.finish = finish;
