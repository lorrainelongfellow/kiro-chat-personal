'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateImages, limits, install } = require('../src/compat/kiro-chat-images.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
const image = () => ({ id: 'fixture-image', mimeType: 'image/png', data: png });

test('validate image bytes and pass only standard ACP image content fields', () => {
    assert.deepEqual(validateImages([image()]), [{ type: 'image', mimeType: 'image/png', data: png }]);
    assert.deepEqual(validateImages(undefined), []);
    assert.throws(() => validateImages([{ ...image(), mimeType: 'image/jpeg' }]));
    assert.throws(() => validateImages([{ ...image(), data: '%%%invalid' }]));
    assert.throws(() => validateImages([{ ...image(), data: 'Zg==' }]));
    assert.throws(() => validateImages(Array(6).fill(image())));
    assert.throws(() => validateImages([{ ...image(), data: 'A'.repeat(Math.ceil(limits.maxBytes / 3) * 4 + 4) }]));
    const bytes = Buffer.alloc(limits.maxBytes); Buffer.from(png, 'base64').copy(bytes);
    assert.throws(() => validateImages(Array(5).fill({ ...image(), data: bytes.toString('base64') })), /20 MiB/);
});

function fixture() {
    class Cli {
        constructor() { this._kiroCapabilities = { promptCapabilities: { image: true } }; this.writes = []; this.fail = false; }
        _writeToStdin(data) { this.writes.push(data); }
        async sendPrompt(text) { this._writeToStdin({ method: 'session/prompt', params: { prompt: [{ type: 'text', text }] } }); if (this.fail) throw Error('fixture failure'); return {}; }
        dispose() {}
    }
    class Panel {
        constructor() { this.cli = new Cli(); this.posts = []; this._cliManager = { _process: this.cli, ensureProcess: async () => this.cli }; }
        _postMessage(data) { this.posts.push(data); }
        async _onWebviewMessage(data) {
            if (data.type === 'sendMessage') this.last = data.text;
            if (['sendMessage', 'retry'].includes(data.type)) try { await this.cli.sendPrompt(this.last); } catch (error) { this._postMessage({ type: 'error', message: error.message }); }
        }
    }
    install({ CliProcess: Cli, ChatPanelProvider: Panel });
    return new Panel();
}

test('paste payload becomes real inline ACP image blocks and ordinary text stays text-only', async () => {
    const panel = fixture();
    await panel._onWebviewMessage({ type: 'sendMessage', text: 'look at this', images: [image()] });
    assert.equal(panel.cli.writes[0].params.prompt[1].data, png);
    assert.equal(panel.cli.writes[0].params.prompt[1].type, 'image');
    assert(panel.posts.some(post => post.type === 'imageSendFinished' && post.success));
    assert.equal(panel.cli._kiroActiveImages, null);
    await panel._onWebviewMessage({ type: 'sendMessage', text: 'text only', images: [] });
    assert.deepEqual(panel.cli.writes.at(-1).params.prompt, [{ type: 'text', text: 'text only' }]);
});

test('unsupported capability rejects before any prompt, and failed sends preserve images for retry', async () => {
    const panel = fixture(); panel.cli._kiroCapabilities = {};
    await panel._onWebviewMessage({ type: 'sendMessage', images: [image()] });
    assert.equal(panel.cli.writes.length, 0);
    assert(panel.posts.some(post => post.type === 'imageSendFinished' && !post.success));
    panel.cli._kiroCapabilities = { promptCapabilities: { image: true } }; panel.cli.fail = true;
    await panel._onWebviewMessage({ type: 'sendMessage', text: 'retry this', images: [image()] });
    assert(panel.cli._kiroImageRetry);
    panel.cli.fail = false; await panel._onWebviewMessage({ type: 'retry' });
    assert.equal(panel.cli.writes.at(-1).params.prompt[1].data, png);
    assert.equal(panel.cli._kiroImageRetry, null);
    panel.cli.dispose(); assert.equal(panel.cli._kiroActiveImages, null);
});

test('an image-only request gets a text caption and invalid input is not sent', async () => {
    const panel = fixture(); await panel._onWebviewMessage({ type: 'sendMessage', images: [image()] });
    assert.equal(panel.cli.writes[0].params.prompt[0].text, '请查看附加图片');
    await panel._onWebviewMessage({ type: 'sendMessage', text: 'invalid', images: [{ ...image(), data: '/etc/passwd' }] });
    assert.equal(panel.cli.writes.length, 1);
    assert.equal(panel._kiroImageRequest, null);
});

test('native history replay preserves bounded image previews with their user message', async () => {
    class Cli {
        constructor() { this._kiroStartOptions = { engine: 'v3', sessionId: 'fixture-session' }; this._kiroModelCatalogReady = true; }
        _processLine() {}
        _nextId() { return 1; }
        _parseConfigOptions() { return []; }
        async refreshEffortOptions() {}
        async sendPrompt() { throw Error('No model calls'); }
        async _sendRaw(request) {
            if (request.method === 'initialize') return { result: { agentCapabilities: { loadSession: true } } };
            this._onSessionUpdate({ sessionUpdate: 'user_message_chunk', _meta: { messageId: 'message-1' }, content: { type: 'image', mimeType: 'image/png', data: png } });
            this._onSessionUpdate({ sessionUpdate: 'user_message_chunk', _meta: { messageId: 'message-1' }, content: { type: 'text', text: 'question about image' } });
            return { result: { sessionId: 'fixture-session' } };
        }
    }
    class Panel { _postMessage() {} async _onWebviewMessage() {} async handleUserMessage() {} }
    class Manager {}
    require('../src/compat/kiro-chat-history.js').install({ CliProcess: Cli, CliManager: Manager, ChatPanelProvider: Panel, vscode: {} });
    const cli = new Cli(); await cli.initializeAndCreateSession(process.cwd());
    assert.equal(cli._kiroTranscript.length, 1);
    assert.equal(cli._kiroTranscript[0].text, 'question about image');
    assert.equal(cli._kiroTranscript[0].images[0].url, 'data:image/png;base64,' + png);
});
