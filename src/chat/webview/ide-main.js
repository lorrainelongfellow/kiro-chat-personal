(() => {
    'use strict';
    const api = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const state = { options: [], busy: true, turning: false, cancelled: false, sessionId: '', history: [],
        historySelecting: false, historySelected: new Set(), historyResult: '',
        attachments: [], images: [], imageReading: 0, imageSupported: false, imageDraft: '', context: {}, tools: new Map(), permissions: new Map(), nativeTools: false, hasMessages: false,
        credits: null, creditsLoading: false, creditsError: '', catalogNotificationAt: null };
    const effortNames = { low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
    const modeNames = { vibe: 'Default', kiro_default: 'Default', kiro_planner: 'Plan', kiro_guide: 'Guide' };
    const agentInfo = {
        spec: ['▤', 'Spec', '结构化功能开发，从需求到设计和实现'],
        plan: ['☷', 'Plan', '先分析并制定计划，不直接修改代码'],
        'bug-fix': ['♧', 'Bug Fix', '调查问题、定位原因并修复缺陷'],
        'quick-spec': ['☷', 'Quick Spec', '快速澄清需求，生成设计和任务'],
    };
    const sendIcon = '<svg viewBox="0 0 20 20"><path d="m5 10 5-5 5 5M10 5v11"/></svg>';
    const stopIcon = '<svg viewBox="0 0 20 20"><rect x="5" y="5" width="10" height="10" rx="1" fill="currentColor" stroke="none"/></svg>';
    let assistant = null, frame = 0;
    marked.setOptions({ gfm: true, breaks: true });

    function node(tag, className, text) {
        const item = document.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    }
    function config(id) { return state.options.find(option => option.id === id || option.category === id); }
    function selected(option) { return option?.options.find(choice => choice.value === option.currentValue); }
    function status(text) { $('status-text').textContent = text || 'Enter 发送 · Shift+Enter 换行'; }
    function showEmpty(empty) { $('welcome').classList.toggle('hidden', !empty); state.hasMessages = !empty; }
    function scrollEnd(force = false) {
        const scroll = $('conversation-scroll');
        if (force || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180) {
            requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
        }
    }
    function closePopups(except) {
        for (const popup of document.querySelectorAll('.popover')) if (popup.id !== except) popup.classList.add('hidden');
        for (const trigger of document.querySelectorAll('[data-popup]')) {
            trigger.setAttribute('aria-expanded', String(trigger.dataset.popup === except));
        }
    }
    function togglePopup(id) {
        const popup = $(id), opening = popup.classList.contains('hidden');
        closePopups(opening ? id : undefined);
        if (!opening) return;
        popup.classList.remove('hidden');
        if (id === 'model-popup') { $('model-new-badge').classList.add('hidden'); $('model-search').value = ''; renderModels(); $('model-search').focus(); }
        if (id === 'mode-popup') renderModes();
        if (id === 'effort-popup') renderEffort();
        if (id === 'history-panel') { $('history-search').focus(); api.postMessage({ type: 'listHistory' }); }
        if (id === 'credits-panel') api.postMessage({ type: 'refreshCreditUsage' });
        if (id === 'account-panel') api.postMessage({ type: 'refreshAccount' });
        if (id === 'diagnostics-panel') api.postMessage({ type: 'getDiagnostics' });
        if (id === 'changes-panel') api.postMessage({ type: 'listTurnChanges' });
    }
    function choose(configId, value) {
        if (state.busy) return;
        const option = state.options.find(option => option.id === configId);
        if (!option?.options.some(choice => choice.value === value)) return;
        closePopups(); setBusy(true);
        api.postMessage({ type: 'selectModel', configId, value });
    }
    function setBusy(busy) { state.busy = busy; renderControls(); }
    function renderControls() {
        const model = config('model'), effort = config('effortLevel'), mode = config('mode'), autopilot = config('autopilot');
        $('model-label').textContent = selected(model)?.name || model?.currentValue || (state.disconnected ? '未连接' : '连接中…');
        $('model-trigger').disabled = state.busy || !model?.options.length;
        $('effort-trigger').classList.toggle('hidden', !effort?.options.length);
        $('effort-trigger').disabled = state.busy || !effort?.options.length;
        $('effort-label').textContent = effortNames[effort?.currentValue] || selected(effort)?.name || '默认';
        $('mode-trigger').disabled = state.busy || !mode?.options.length;
        $('mode-label').textContent = modeNames[mode?.currentValue] || selected(mode)?.name || 'Default';
        $('autopilot-control').classList.toggle('hidden', !autopilot);
        $('autopilot-toggle').checked = autopilot?.currentValue === 'on';
        $('autopilot-toggle').disabled = state.busy || !autopilot;
        $('new-chat-btn').disabled = state.busy;
        $('attach-btn').disabled = state.busy;
        $('context-btn').disabled = state.busy || !state.context.available;
        $('see-all-modes').disabled = state.busy || !mode?.options.length;
        $('send-btn').disabled = !state.turning && (state.busy || !model?.options.length || !!state.imageReading || (state.images.length > 0 && !state.imageSupported));
        $('send-btn').classList.toggle('stop', state.turning);
        $('send-btn').innerHTML = state.turning ? stopIcon : sendIcon;
        $('send-btn').title = state.turning ? '停止生成' : '发送消息';
        $('send-btn').setAttribute('aria-label', $('send-btn').title);
        $('loading-indicator').classList.toggle('hidden', !state.busy);
        $('loading-text').textContent = state.turning ? 'Kiro 正在思考…' : '正在连接或应用设置…';
        renderHistory();
        renderAgents();
        window.kiroManagementControls?.();
    }
    function renderAgents() {
        const mode = config('mode'); $('agent-cards').replaceChildren();
        for (const [id, info] of Object.entries(agentInfo)) {
            const offered = mode?.options.find(option => option.value === id || (id === 'plan' && option.value === 'kiro_planner'));
            if (!offered) continue;
            const card = node('button', 'agent-card' + (mode.currentValue === offered.value ? ' active' : ''));
            card.disabled = state.busy;
            card.append(node('span', 'agent-icon', info[0]), node('span', 'agent-name', info[1]), node('span', 'agent-description', info[2]));
            card.title = offered.description || info[2];
            card.addEventListener('click', () => { choose(mode.id, offered.value); $('message-input').focus(); });
            $('agent-cards').append(card);
        }
        $('welcome-status').textContent = mode?.options.length ?
            ($('agent-cards').children.length ? '' : '在下方选择模式，或直接描述你的任务。') : '正在读取可用模式…';
    }
    function optionButton(choice, current, className, callback, meta = '') {
        const button = node('button', className + (choice.value === current ? ' selected' : ''));
        button.setAttribute('aria-label', choice.name || choice.value);
        button.disabled = state.busy;
        const top = node('div', 'option-top');
        top.append(node('span', 'option-name', choice.name || choice.value), node('span', 'option-meta', meta || (choice.value === current ? '✓' : '')));
        button.append(top);
        if (choice.description) button.append(node('div', 'option-description', choice.description));
        button.addEventListener('click', callback); return button;
    }
    function renderModels() {
        const model = config('model'), query = $('model-search').value.trim().toLowerCase();
        $('model-list').replaceChildren();
        for (const choice of model?.options || []) {
            if (!(choice.name + ' ' + choice.value + ' ' + choice.description).toLowerCase().includes(query)) continue;
            const meta = choice._meta?.kiro;
            const rate = typeof meta?.rateMultiplier === 'number' ? meta.rateMultiplier + 'x ' + (meta.rateUnit || 'Credit') : '';
            const button = optionButton(choice, model.currentValue, 'model-option', () => choose(model.id, choice.value), rate);
            button.title = choice.description || choice.name;
            $('model-list').append(button);
        }
        if (!$('model-list').children.length) $('model-list').append(node('div', 'empty-list', '没有匹配的模型'));
        const effort = config('effortLevel'); $('model-effort-footer').replaceChildren();
        if (!effort?.options.length) $('model-effort-footer').textContent = '当前模型没有可手动设置的思考强度。';
        else {
            $('model-effort-footer').append(node('span', '', '思考强度'));
            const choices = node('div', 'effort-buttons');
            for (const item of effort.options) {
                const button = node('button', 'effort-segment' + (item.value === effort.currentValue ? ' selected' : ''), effortNames[item.value] || item.name);
                button.disabled = state.busy; button.addEventListener('click', () => choose(effort.id, item.value)); choices.append(button);
            }
            $('model-effort-footer').append(choices);
        }
    }
    function renderEffort() {
        const effort = config('effortLevel'); $('effort-list').replaceChildren();
        for (const choice of effort?.options || []) $('effort-list').append(optionButton(
            { ...choice, name: effortNames[choice.value] || choice.name }, effort.currentValue, 'effort-option', () => choose(effort.id, choice.value)));
    }
    function renderModes() {
        const mode = config('mode'); $('mode-list').replaceChildren();
        for (const choice of mode?.options || []) $('mode-list').append(optionButton(
            { ...choice, name: modeNames[choice.value] || choice.name }, mode.currentValue, 'mode-option', () => choose(mode.id, choice.value)));
    }
    function filteredHistory() {
        const query = $('history-search').value.trim().toLowerCase();
        return state.history.filter(item => (item.title + ' ' + item.sessionId).toLowerCase().includes(query));
    }
    function toggleHistorySelection(id) {
        if (state.busy || state.historyBusy) return;
        if (state.historySelected.has(id)) state.historySelected.delete(id); else state.historySelected.add(id);
        state.historyResult = ''; renderHistory();
    }
    function renderHistory() {
        $('history-list').replaceChildren();
        const matches = filteredHistory(), disabled = state.busy || state.historyBusy;
        $('history-multiselect').disabled = disabled;
        $('history-multiselect').textContent = state.historySelecting ? '退出多选' : '多选';
        $('history-multiselect').setAttribute('aria-pressed', String(state.historySelecting));
        $('history-selection').classList.toggle('hidden', !state.historySelecting);
        const selectedMatches = matches.filter(item => state.historySelected.has(item.sessionId)).length;
        $('history-select-all').checked = !!matches.length && selectedMatches === matches.length;
        $('history-select-all').indeterminate = selectedMatches > 0 && selectedMatches < matches.length;
        $('history-select-all').disabled = disabled || !matches.length;
        $('history-selection-count').textContent = '已选 ' + state.historySelected.size + ' 条';
        $('history-delete-selected').disabled = disabled || !state.historySelected.size;
        $('history-result').textContent = state.historyResult;
        $('history-result').classList.toggle('hidden', !state.historyResult);
        for (const session of matches) {
            const row = node('div', 'history-row');
            const body = node('div', 'history-row-body');
            if (state.historySelecting) {
                const checkbox = node('input', 'history-checkbox'); checkbox.type = 'checkbox';
                checkbox.checked = state.historySelected.has(session.sessionId); checkbox.disabled = disabled;
                checkbox.setAttribute('aria-label', '选择对话：' + session.title);
                checkbox.addEventListener('change', () => toggleHistorySelection(session.sessionId)); body.append(checkbox);
            }
            const item = node('button', 'history-item' + (session.sessionId === state.sessionId ? ' active' : ''));
            item.disabled = disabled; item.title = session.title;
            const title = session.title.replace(/^\[Active file: (.+)\]$/, (_, file) => file.split(/[\\/]/).at(-1) + ' 的对话');
            item.append(node('span', 'history-item-title', (session.pinned ? '★ ' : '') + title), node('span', 'history-item-detail',
                new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false }) +
                (session.messageCount !== undefined ? ' · ' + session.messageCount + ' 条消息' : '') +
                (session.sessionId === state.sessionId ? ' · 当前' : '')));
            item.addEventListener('click', () => {
                if (disabled) return;
                if (state.historySelecting) return toggleHistorySelection(session.sessionId);
                setBusy(true); $('history-status').textContent = '正在恢复对话…';
                api.postMessage({ type: 'resumeHistory', sessionId: session.sessionId });
            });
            const actions = node('div', 'history-actions' + (state.historySelecting ? ' hidden' : ''));
            for (const [type, label] of [['pinHistory', session.pinned ? '取消置顶' : '置顶'], ['renameHistory', '重命名'], ['exportHistory', '导出'], ['deleteHistory', '删除']]) {
                const button = node('button', 'text-button', label);
                if (type === 'deleteHistory') { button.classList.add('history-delete'); button.title = '删除这条 CLI 历史记录'; }
                button.disabled = state.busy || state.historyBusy;
                button.addEventListener('click', () => api.postMessage({ type, sessionId: session.sessionId })); actions.append(button);
            }
            body.append(item); row.append(body, actions); $('history-list').append(row);
        }
        $('history-status').textContent = state.historyBusy ? '正在处理历史…' : matches.length ? matches.length + ' 个对话 · 当前工作区' : $('history-search').value.trim() ? '没有匹配的对话' : '当前工作区还没有历史对话';
    }
    function renderCredits() {
        const usage = state.credits;
        const format = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
        const content = $('credits-content'); content.replaceChildren();
        $('credits-refresh').disabled = state.creditsLoading;
        $('credits-trigger').classList.toggle('credits-unavailable', !!state.creditsError);
        $('credits-summary').textContent = usage ? (usage.remaining === null ? '已用 ' + format(usage.used) : '剩余 ' + format(usage.remaining)) :
            state.creditsLoading ? '读取积分…' : state.creditsError ? '积分未获取' : '积分用量';
        $('credits-trigger').title = usage ? '本月已用 ' + format(usage.used) + (usage.limit === null ? '' : ' / ' + format(usage.limit)) + ' 积分，点击查看详情' : '查看账户积分用量';
        if (usage) {
            const top = node('div', 'credits-plan');
            top.append(node('strong', '', usage.planName || '当前套餐'), node('span', 'muted', '本月积分'));
            content.append(top, node('div', 'credits-account', usage.account));
            const values = node('div', 'credits-values');
            values.append(node('strong', '', format(usage.used)), node('span', 'muted', usage.limit === null ? ' 已用积分' : ' / ' + format(usage.limit) + ' 积分'));
            content.append(values);
            if (usage.limit !== null && usage.limit > 0) {
                const percentage = Math.max(0, Math.min(100, usage.used / usage.limit * 100));
                const track = node('div', 'credits-progress');
                track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', '本月积分使用比例');
                track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(usage.limit));
                track.setAttribute('aria-valuenow', String(Math.min(usage.limit, Math.max(0, usage.used))));
                track.setAttribute('aria-valuetext', format(usage.used) + ' / ' + format(usage.limit) + ' 积分');
                const bar = node('div', 'credits-progress-fill'); bar.style.width = percentage + '%'; track.append(bar); content.append(track);
            }
            const detail = node('div', 'credits-details');
            const row = (label, value) => { const item = node('div'); item.append(node('span', 'muted', label), node('span', '', value)); detail.append(item); };
            if (usage.remaining !== null) row('本月套餐剩余', format(usage.remaining) + ' 积分');
            if (usage.limit !== null && usage.limit > 0) row('已用比例', (usage.used / usage.limit * 100).toFixed(2) + '%');
            if (usage.reset) row('下次重置', usage.reset);
            if (usage.currentOverages > 0) row('超额用量', format(usage.currentOverages) + ' 积分');
            if (usage.bonusCount || usage.addOnCount) row('其他额度', '账户含额外积分，详情以官方账户页为准');
            content.append(detail);
            $('credits-status').textContent = 'CLI 官方估算 · 更新于 ' + new Date(usage.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false });
        } else {
            content.append(node('p', state.creditsError ? 'credits-error' : 'muted', state.creditsError || '正在读取 CLI 账户用量…'));
            $('credits-status').textContent = '数据来自 Kiro CLI · 官方估算用量';
        }
        if (state.creditsLoading) $('credits-status').textContent = '正在刷新账户积分…';
    }
    function markdown(element, text, complete) {
        element.innerHTML = DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'img'], FORBID_ATTR: ['style'] });
        if (!complete) return;
        for (const pre of element.querySelectorAll('pre')) {
            const code = pre.querySelector('code');
            const language = code?.className.match(/language-([^\s]+)/)?.[1] || 'code';
            pre.append(node('span', 'code-language', language));
            const copy = node('button', 'copy-button', '复制');
            copy.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(code?.textContent || ''); copy.textContent = '已复制'; }
                catch { copy.textContent = '复制失败'; }
                setTimeout(() => { copy.textContent = '复制'; }, 1600);
            }); pre.append(copy);
        }
    }
    function message(role, text, images = []) {
        showEmpty(false);
        const bubble = node('article', 'message ' + role);
        if (role === 'assistant') {
            bubble.append(node('div', 'role-label', 'KIRO')); const body = node('div', 'markdown');
            bubble.append(body); markdown(body, text, true);
        } else if (role === 'user' && text.length > 1600) {
            bubble.append(node('div', '', text.slice(0, 280) + '…'));
            const details = node('details', 'long-prompt'); details.append(node('summary', '', '展开完整提问与上下文'), node('pre', '', text)); bubble.append(details);
        } else bubble.textContent = text;
        if (images.length) {
            const previews = node('div', 'message-images');
            for (const image of images) { const preview = node('img'); preview.src = image.url; preview.alt = image.name; previews.append(preview); }
            bubble.append(previews);
        }
        $('messages').append(bubble); return bubble;
    }
    function finishAssistant() {
        if (!assistant) return;
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        markdown(assistant.body, assistant.text, true); assistant = null;
    }
    function appendAssistant(text, done) {
        if (!assistant && !text) return;
        if (!assistant) {
            const bubble = message('assistant', ''); assistant = { body: bubble.querySelector('.markdown'), text: '' };
        }
        assistant.text += text;
        if (done) finishAssistant();
        else if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (assistant) markdown(assistant.body, assistant.text, false); scrollEnd(); });
        scrollEnd();
    }
    function toolEvent(event) {
        finishAssistant(); showEmpty(false);
        const id = event.id || event.toolCallId || 'legacy-' + (event.text || event.title);
        let entry = state.tools.get(id);
        if (!entry) {
            const card = node('details', 'tool-card'), summary = node('summary');
            const icon = node('span', 'tool-icon', '◌'), title = node('span', 'tool-name', event.title || event.text || '工具操作'), label = node('span', 'tool-state');
            summary.append(icon, title, label); const detail = node('pre', 'tool-detail'); card.append(summary, detail);
            $('messages').append(card); entry = { card, icon, title, label, detail }; state.tools.set(id, entry);
        }
        if (event.title || event.text) entry.title.textContent = event.title || event.text;
        const complete = event.status === 'completed', failed = event.status === 'failed';
        entry.icon.textContent = complete ? '✓' : failed ? '!' : '◌';
        entry.label.textContent = complete ? '已完成' : failed ? '失败' : '执行中';
        if (event.detail) entry.detail.textContent = event.detail;
        scrollEnd();
    }
    function renderAttachments() {
        $('attachment-list').replaceChildren();
        const entries = state.attachments.map(file => ({ ...file, remove: () => { state.attachments = state.attachments.filter(item => item.path !== file.path); renderAttachments(); } }));
        if (state.context.available && state.context.included) entries.unshift({ name: state.context.name,
            remove: () => api.postMessage({ type: 'editorContext', included: false }) });
        for (const entry of entries) {
            const chip = node('span', 'attachment-chip'); chip.title = entry.path || '当前编辑器上下文';
            const remove = node('button', '', '×'); remove.title = '移除'; remove.addEventListener('click', entry.remove);
            chip.append(node('span', '', entry.name), remove); $('attachment-list').append(chip);
        }
        for (const image of state.images) {
            const chip = node('span', 'attachment-chip image-chip'), preview = node('img'); preview.src = image.url; preview.alt = image.name;
            const remove = node('button', '', '×'); remove.title = '移除图片'; remove.setAttribute('aria-label', '移除图片：' + image.name);
            remove.addEventListener('click', () => { state.images = state.images.filter(item => item.id !== image.id); renderAttachments(); renderControls(); });
            chip.append(preview, node('span', '', image.name), remove); $('attachment-list').append(chip);
        }
        $('attachment-list').classList.toggle('hidden', !entries.length && !state.images.length);
        $('context-btn').setAttribute('aria-pressed', String(!!state.context.included));
        $('context-label').textContent = state.context.available && state.context.included ? state.context.name : '';
    }
    async function pasteImages(event) {
        const files = [...event.clipboardData?.items || []].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
        if (!files.length) return;
        event.preventDefault();
        if (!state.imageSupported) { status('当前会话尚未提供图片输入能力，请先连接支持图片的 CLI'); return; }
        if (state.images.length + files.length > 5) { status('最多附加 5 张图片'); return; }
        state.imageReading++; renderControls();
        const sessionId = state.sessionId;
        try {
            const added = [];
            for (const file of files) {
                if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('只支持 PNG、JPEG、WebP 图片');
                if (file.size > 5 * 1024 * 1024) throw new Error('单张图片不能超过 5 MiB');
                const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取剪贴板图片')); reader.readAsDataURL(file); });
                added.push({ id: crypto.randomUUID(), name: file.name || '粘贴的图片.png', mimeType: file.type, data: url.slice(url.indexOf(',') + 1), url, size: file.size });
            }
            if (state.images.length + added.length > 5 || [...state.images, ...added].reduce((sum, image) => sum + image.size, 0) > 20 * 1024 * 1024) throw new Error('最多 5 张图片，合计不能超过 20 MiB');
            if (state.sessionId !== sessionId) return;
            state.images.push(...added); status('已粘贴 ' + added.length + ' 张图片，发送后由当前模型处理'); renderAttachments();
        } catch (error) { status(error.message); }
        finally { state.imageReading--; renderControls(); }
    }
    function renderPermissions() {
        $('permission-panel').replaceChildren(); const request = state.permissions.values().next().value;
        $('permission-panel').classList.toggle('hidden', !request); if (!request) return;
        $('permission-panel').append(node('strong', '', request.title)); const actions = node('div', 'permission-actions');
        const respond = (optionId, allowConversation = false) => {
            api.postMessage({ type: 'permissionResponse', requestId: request.requestId, sessionId: request.sessionId, optionId, allowConversation });
            state.permissions.delete(request.requestId); renderPermissions();
        };
        for (const choice of request.options) {
            const button = node('button', 'action-button' + (choice.kind === 'allow_once' ? ' primary' : ''), choice.kind === 'allow_once' ? '本次允许' : '本次拒绝');
            button.title = choice.name; button.addEventListener('click', () => respond(choice.optionId)); actions.append(button);
        }
        const once = request.options.find(choice => choice.kind === 'allow_once');
        if (once && request.allowConversation !== false) {
            const remember = node('button', 'action-button', '本对话始终允许');
            remember.title = '自动确认当前对话后续可允许的工具请求；切换对话、重连或重载后失效，可随时恢复逐次确认。';
            remember.addEventListener('click', () => respond(once.optionId, true)); actions.append(remember);
        }
        const cancel = node('button', 'action-button', '取消'); cancel.addEventListener('click', () => respond(null)); actions.append(cancel); $('permission-panel').append(actions);
    }
    function submit() {
        if (state.turning) { if (!state.cancelled) { state.cancelled = true; api.postMessage({ type: 'cancelPrompt' }); status('正在停止生成…'); } return; }
        if (state.busy || !config('model')?.options.length) return;
        if (state.imageReading || (state.images.length && !state.imageSupported)) return;
        const text = $('message-input').value.trim(); if (!text && !state.attachments.length && !state.images.length) return;
        closePopups(); finishAssistant(); message('user', text || (state.images.length ? '请查看附加图片' : '请查看附加的文件'), state.images); scrollEnd(true);
        state.imageDraft = state.images.length ? text : '';
        api.postMessage({ type: 'sendMessage', text, attachments: state.attachments.map(file => file.path), images: state.images.map(({ id, mimeType, data }) => ({ id, mimeType, data })) });
        $('message-input').value = ''; $('message-input').style.height = '';
        state.attachments = []; state.tools.clear(); state.nativeTools = false; renderAttachments(); setBusy(true);
    }
    function renderSpec(message) {
        const bar = $('spec-phase-bar'); bar.replaceChildren();
        const phases = message.phases || ['requirements', 'design', 'tasks'];
        if (message.phaseIndex < 0 || !phases.length) { bar.classList.add('hidden'); return; }
        bar.classList.remove('hidden');
        phases.forEach((phase, index) => bar.append(node('span', 'spec-phase' + (index === message.phaseIndex ? ' active' : ''), phase)));
        if (message.type === 'specPhaseBar') for (const [label, type] of [['保存', 'specSave'], ['保存并继续', 'specAccept'], ['取消', 'specCancel']]) {
            const button = node('button', 'text-button', label); button.addEventListener('click', () => api.postMessage({ type })); bar.append(button);
        }
    }

    for (const trigger of document.querySelectorAll('[data-popup]')) trigger.addEventListener('click', () => togglePopup(trigger.dataset.popup));
    document.addEventListener('pointerdown', event => { if (!event.target.closest('.popover') && !event.target.closest('[data-popup]')) closePopups(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closePopups(); });
    $('model-search').addEventListener('input', renderModels); $('history-search').addEventListener('input', renderHistory);
    $('models-refresh').addEventListener('click', () => api.postMessage({ type: 'refreshModels', force: true }));
    $('history-close').addEventListener('click', () => closePopups());
    $('history-refresh').addEventListener('click', () => api.postMessage({ type: 'listHistory' }));
    $('history-multiselect').addEventListener('click', () => {
        state.historySelecting = !state.historySelecting; state.historySelected.clear(); state.historyResult = ''; renderHistory();
    });
    $('history-select-all').addEventListener('change', () => {
        for (const item of filteredHistory()) {
            if ($('history-select-all').checked) state.historySelected.add(item.sessionId); else state.historySelected.delete(item.sessionId);
        }
        state.historyResult = ''; renderHistory();
    });
    $('history-delete-selected').addEventListener('click', () => {
        if (state.busy || state.historyBusy || !state.historySelected.size) return;
        state.historyResult = ''; api.postMessage({ type: 'deleteHistoryBatch', sessionIds: [...state.historySelected] });
    });
    $('credits-close').addEventListener('click', () => closePopups());
    $('credits-refresh').addEventListener('click', () => api.postMessage({ type: 'refreshCreditUsage', force: true }));
    $('new-chat-btn').addEventListener('click', () => { if (!state.busy) { closePopups(); setBusy(true); api.postMessage({ type: 'clearChat' }); } });
    $('attach-btn').addEventListener('click', () => api.postMessage({ type: 'attachFiles' }));
    $('context-btn').addEventListener('click', () => api.postMessage({ type: 'editorContext', included: !state.context.included }));
    $('autopilot-toggle').addEventListener('change', () => choose('autopilot', $('autopilot-toggle').checked ? 'on' : 'off'));
    $('send-btn').addEventListener('click', submit);
    $('permission-policy-revoke').addEventListener('click', () => api.postMessage({ type: 'revokeConversationPermission', sessionId: state.permissionSessionId }));
    $('message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); } });
    $('message-input').addEventListener('input', () => { $('message-input').style.height = 'auto'; $('message-input').style.height = Math.min($('message-input').scrollHeight, 190) + 'px'; });
    $('message-input').addEventListener('paste', pasteImages);
    window.addEventListener('message', event => {
        const messageData = event.data;
        switch (messageData.type) {
            case 'configOptions':
                state.options = messageData.options; state.disconnected = false; renderControls();
                if (!$('model-popup').classList.contains('hidden')) renderModels();
                if (!$('effort-popup').classList.contains('hidden')) renderEffort();
                if (!$('mode-popup').classList.contains('hidden')) renderModes();
                if (config('model')?.options.length) $('connection-dot').classList.add('connected');
                break;
            case 'loading': setBusy(!!messageData.active); if (!messageData.active) status(); break;
            case 'modelCatalog': {
                const time = messageData.checkedAt ? new Date(messageData.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
                const added = messageData.added?.length ? '新增：' + messageData.added.join('、') : '';
                const label = messageData.state === 'checking' ? '正在检查 CLI 新模型…' :
                    messageData.state === 'manual' ? '模型列表来自 CLI，点击“刷新”检查更新' :
                    messageData.state === 'refreshing' ? '正在刷新模型，保留当前对话…' :
                    messageData.state === 'pending' ? (added || '模型列表有变化') + '，将在当前任务结束后刷新' :
                    messageData.state === 'error' ? messageData.message :
                    (added || '模型列表已同步，共 ' + messageData.count + ' 项') + ' · ' + time;
                $('model-catalog-status').textContent = label;
                $('model-catalog-status').classList.toggle('catalog-error', messageData.state === 'error');
                $('models-refresh').disabled = ['checking', 'refreshing'].includes(messageData.state);
                $('model-trigger').title = label + '；仅手动检查更新';
                if (messageData.state === 'updated' && added && messageData.checkedAt !== state.catalogNotificationAt) {
                    state.catalogNotificationAt = messageData.checkedAt;
                    $('model-new-badge').textContent = '+' + messageData.added.length;
                    $('model-new-badge').title = added;
                    $('model-new-badge').classList.remove('hidden');
                }
                break;
            }
            case 'creditUsage': state.credits = messageData.usage; state.creditsError = ''; renderCredits(); break;
            case 'creditUsageLoading': state.creditsLoading = !!messageData.active; renderCredits(); break;
            case 'creditUsageError': state.credits = null; state.creditsError = messageData.message; renderCredits(); break;
            case 'turnState': state.turning = !!messageData.active; state.cancelled = false; if (messageData.active) state.tools.clear(); else { state.permissions.clear(); renderPermissions(); } renderControls(); break;
            case 'response': appendAssistant(messageData.content, messageData.done); break;
            case 'toolEvent': state.nativeTools = true; toolEvent(messageData); break;
            case 'toolStatus': if (!state.nativeTools) toolEvent(messageData); break;
            case 'error': finishAssistant(); message('error', messageData.message); if (!state.turning) setBusy(false); scrollEnd(true); break;
            case 'systemMessage':
                if (messageData.message.startsWith('当前账户：')) { $('account-label').textContent = messageData.message.slice(5); $('account-label').title = messageData.message; }
                else status(messageData.message);
                break;
            case 'restoreConversation':
                finishAssistant(); $('messages').replaceChildren(); state.tools.clear(); state.permissions.clear(); state.nativeTools = false; renderPermissions();
                if (messageData.account) $('account-label').textContent = messageData.account.replace(/^当前账户：/, '');
                for (const entry of messageData.entries) {
                    if (entry.role === 'user' || entry.role === 'assistant') message(entry.role, entry.text, entry.images || []);
                    else if (entry.role === 'tool') toolEvent(entry);
                }
                showEmpty(!messageData.entries.length); scrollEnd(true); break;
            case 'clearChat': finishAssistant(); $('messages').replaceChildren(); showEmpty(true); break;
            case 'currentSession':
                if (state.sessionId !== messageData.sessionId) { state.images = []; state.imageDraft = ''; renderAttachments(); }
                state.sessionId = messageData.sessionId; $('conversation-title').textContent = messageData.title === '新对话' ? 'New Session' : messageData.title; $('conversation-title').title = messageData.title; break;
            case 'historyList':
                state.history = messageData.sessions; state.sessionId = messageData.currentSessionId || state.sessionId;
                for (const id of state.historySelected) if (!state.history.some(item => item.sessionId === id)) state.historySelected.delete(id);
                renderHistory(); break;
            case 'historyLoading': state.historyBusy = !!messageData.active; $('history-refresh').disabled = !!messageData.active; renderHistory(); if (messageData.active) $('history-status').textContent = '正在读取历史…'; break;
            case 'historyNotice': status(messageData.message); break;
            case 'historyDeleted': state.history = state.history.filter(item => item.sessionId !== messageData.sessionId); state.historySelected.delete(messageData.sessionId); renderHistory(); break;
            case 'historyProgress': $('history-status').textContent = messageData.message; break;
            case 'historyBatchResult':
                state.historyResult = '已删除 ' + messageData.deleted.length + ' 条' + (messageData.failures.length ? '，' + messageData.failures.length + ' 条未完成' : '') +
                    messageData.failures.map(item => '\n' + item.title + '：' + item.message).join('') +
                    (messageData.warnings.length ? '\n' + [...new Set(messageData.warnings)].join('\n') : '');
                renderHistory(); break;
            case 'historyRestored': closePopups(); $('message-input').value = ''; state.attachments = []; state.images = []; renderAttachments(); break;
            case 'imageCapability': state.imageSupported = !!messageData.supported; renderControls(); break;
            case 'imageSendFinished':
                if (messageData.success) state.images = state.images.filter(image => !messageData.ids.includes(image.id));
                else { if (!$('message-input').value) $('message-input').value = state.imageDraft; status('发送失败，图片已保留，可调整模型或重试'); }
                state.imageDraft = ''; renderAttachments(); renderControls(); break;
            case 'historyError': $('history-panel').classList.remove('hidden'); state.historyResult = messageData.message; renderHistory(); break;
            case 'editorContext': state.context = messageData; $('workspace-label').textContent = messageData.workspace || ''; renderAttachments(); renderControls(); break;
            case 'attachedFiles':
                for (const file of messageData.files) if (!state.attachments.some(item => item.path === file.path)) state.attachments.push(file);
                renderAttachments(); $('message-input').focus(); break;
            case 'permissionRequest': state.permissions.set(messageData.requestId, messageData); renderPermissions(); break;
            case 'permissionResolved':
                if (messageData.sessionId === state.sessionId) { state.permissions.delete(messageData.requestId); renderPermissions(); }
                break;
            case 'permissionPolicy':
                state.permissionSessionId = messageData.sessionId;
                $('permission-policy-status').classList.toggle('hidden', !messageData.enabled);
                break;
            case 'contextUsage': {
                const percentage = Math.max(0, Math.min(100, messageData.usage.total || 0));
                $('context-ring').setAttribute('stroke-dasharray', (percentage / 100 * 44) + ' 44');
                $('context-usage').title = '上下文用量 ' + percentage.toFixed(1) + '%'; break;
            }
            case 'specPhase': case 'specPhaseBar': renderSpec(messageData); break;
        }
    });
    window.installKiroManagement({ api, state, node, $, closePopups, status });
    renderControls(); api.postMessage({ type: 'ready' });
})();
