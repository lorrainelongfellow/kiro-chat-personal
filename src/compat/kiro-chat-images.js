'use strict';

const limits = { maxCount: 5, maxBytes: 5 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 };
function validateImages(input) {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > limits.maxCount) throw new Error('每次最多发送 5 张图片');
    let total = 0;
    return input.map(image => {
        if (!image || typeof image.data !== 'string' || image.data.length > Math.ceil(limits.maxBytes / 3) * 4 ||
            image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('图片数据无效或超过单张 5 MiB 限制');
        const bytes = Buffer.from(image.data, 'base64');
        if (!bytes.length || bytes.length > limits.maxBytes || bytes.toString('base64') !== image.data) throw new Error('图片数据无效或超过单张 5 MiB 限制');
        total += bytes.length;
        if (total > limits.maxTotalBytes) throw new Error('图片合计不能超过 20 MiB');
        const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
            bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' :
                bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
        if (!mimeType || mimeType !== image.mimeType) throw new Error('只支持有效的 PNG、JPEG、WebP 图片');
        return { type: 'image', mimeType, data: image.data };
    });
}

exports.limits = limits;
exports.validateImages = validateImages;
exports.install = function ({ CliProcess, ChatPanelProvider }) {
    const write = CliProcess.prototype._writeToStdin;
    CliProcess.prototype._writeToStdin = function (message) {
        if (message.method === 'session/prompt' && this._kiroActiveImages?.length) {
            if (this._kiroCurrentImageRequest) this._kiroCurrentImageRequest.sent = true;
            message = { ...message, params: { ...message.params, prompt: [...message.params.prompt, ...this._kiroActiveImages] } };
        }
        return write.call(this, message);
    };
    const sendPrompt = CliProcess.prototype.sendPrompt;
    CliProcess.prototype.sendPrompt = async function (text, ...args) {
        const queued = this._kiroQueuedImages;
        delete this._kiroQueuedImages;
        const images = queued !== undefined ? queued : this._kiroImageRetry?.text === text ? this._kiroImageRetry.images : [];
        this._kiroActiveImages = images;
        this._kiroImageRetry = images.length ? { text, images } : null;
        try {
            if (images.length && this._kiroCapabilities?.promptCapabilities?.image !== true) throw new Error('当前 CLI 会话未声明图片输入能力，请重新连接或升级 CLI');
            const result = await sendPrompt.call(this, text, ...args);
            this._kiroImageRetry = null;
            return result;
        } finally { this._kiroActiveImages = null; }
    };
    const dispose = CliProcess.prototype.dispose;
    CliProcess.prototype.dispose = function (...args) {
        this._kiroQueuedImages = null; this._kiroActiveImages = null; this._kiroImageRetry = null;
        return dispose.apply(this, args);
    };
    const post = ChatPanelProvider.prototype._postMessage;
    ChatPanelProvider.prototype._postMessage = function (message) {
        if (message.type === 'error' && this._kiroImageRequest) this._kiroImageRequest.failed = true;
        const result = post.call(this, message);
        if (['configOptions', 'currentSession', 'restoreConversation', 'accountDisconnected'].includes(message.type)) {
            post.call(this, { type: 'imageCapability', supported: this._cliManager._process?._kiroCapabilities?.promptCapabilities?.image === true, limits });
        }
        return result;
    };
    const onMessage = ChatPanelProvider.prototype._onWebviewMessage;
    ChatPanelProvider.prototype._onWebviewMessage = async function (message) {
        if (message.type === 'retry') {
            const cli = this._cliManager._process;
            if (cli?._kiroImageRetry) cli._kiroQueuedImages = cli._kiroImageRetry.images;
            return onMessage.call(this, message);
        }
        if (message.type !== 'sendMessage') return onMessage.call(this, message);
        const ids = Array.isArray(message.images) ? message.images.slice(0, limits.maxCount).map(image => typeof image?.id === 'string' ? image.id.slice(0, 80) : '') : [];
        let cli, request;
        try {
            if (this._kiroImageRequest || this._kiroHistoryBusy || this._cliManager._process?._kiroTurnActive) throw new Error('请等待当前任务完成后再发送');
            request = this._kiroImageRequest = { failed: false, sent: false };
            const images = validateImages(message.images);
            cli = await this._cliManager.ensureProcess();
            if (images.length && cli._kiroCapabilities?.promptCapabilities?.image !== true) throw new Error('当前 CLI 会话未声明图片输入能力，请重新连接或升级 CLI');
            cli._kiroQueuedImages = images;
            cli._kiroCurrentImageRequest = request;
            await onMessage.call(this, { ...message, text: message.text || (images.length ? '请查看附加图片' : '') });
        } catch (error) {
            if (request) request.failed = true;
            post.call(this, { type: 'error', message: error.message });
            if (!request) request = { failed: true };
        } finally {
            if (cli) delete cli._kiroQueuedImages;
            if (cli?._kiroCurrentImageRequest === request) delete cli._kiroCurrentImageRequest;
            if (this._kiroImageRequest === request) this._kiroImageRequest = null;
            if (ids.length) this._postMessage({ type: 'imageSendFinished', ids, success: !!request && request.sent && !request.failed });
        }
    };
};
