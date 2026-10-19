!function(){const e=acquireVsCodeApi(),t=document.getElementById("messages"),n=document.getElementById("loading-indicator"),a=document.getElementById("spec-phase-bar"),s=document.getElementById("message-input"),c=document.getElementById("send-btn"),o=document.getElementById("model-selector"),l=document.getElementById("clear-chat-btn"),r=document.getElementById("context-ring"),i=document.getElementById("context-usage");let d=null,p="",u={},m=null,g=!1,kiroBusy=!0;function h(){if(c.disabled)return;var t=s.value.trim();t&&(function(e){b("user").textContent=e,k()}(t),e.postMessage({type:"sendMessage",text:t}),s.value="",E())}function f(){e.postMessage({type:"retry"})}!function(){g=!0,o.innerHTML="<option value=\"\">正在连接 Kiro…</option>",o.disabled=!0,c.disabled=!0,u={},m="model",g=!1}(),l&&l.addEventListener("click",function(){e.postMessage({type:"clearChat"})});var y=document.getElementById("start-spec-btn");function b(e){var n=document.createElement("div");return n.className="message "+e,t.appendChild(n),n}function x(e){for(var t=e.querySelectorAll("pre"),n=0;n<t.length;n++){var a=t[n];if(!a.querySelector(".copy-btn")){var s=document.createElement("button");s.className="copy-btn",s.textContent="📋",s.title="Copy to clipboard",s.setAttribute("aria-label","Copy code to clipboard"),function(e,t){t.addEventListener("click",function(){var n=e.querySelector("code"),a=n?n.textContent:e.textContent;navigator.clipboard.writeText(a||"").then(function(){t.textContent="✓",setTimeout(function(){t.textContent="📋"},1500)})})}(a,s);var c=a.querySelector(".code-block-header");c?c.appendChild(s):(a.style.position="relative",s.style.position="absolute",s.style.top="4px",s.style.right="4px",a.appendChild(s))}}}function k(){t&&(t.scrollTop=t.scrollHeight)}function E(){s.style.height="auto",s.style.height=Math.min(s.scrollHeight,120)+"px"}function C(e){for(var t="",n=e.replace(/\r\n/g,"\n").split("\n"),a=0;a<n.length;){var s=n[a],c=s.match(/^```(\w*)/);if(c){var o=c[1]||"",l=[];for(a++;a<n.length&&!n[a].match(/^```\s*$/);)l.push(n[a]),a++;a++;var r=l.join("\n");t+="<pre>"+(o?'<div class="code-block-header"><span class="code-lang">'+I(o)+"</span></div>":'<div class="code-block-header"></div>')+"<code>"+L(I(r),o)+"</code></pre>"}else if(s.match(/^\s*[-*+]\s+/)){for(t+="<ul>";a<n.length&&n[a].match(/^\s*[-*+]\s+/);)t+="<li>"+M(n[a].replace(/^\s*[-*+]\s+/,""))+"</li>",a++;t+="</ul>"}else if(s.match(/^\s*\d+\.\s+/)){for(t+="<ol>";a<n.length&&n[a].match(/^\s*\d+\.\s+/);)t+="<li>"+M(n[a].replace(/^\s*\d+\.\s+/,""))+"</li>",a++;t+="</ol>"}else if(""!==s.trim()){var i=s.match(/^(#{1,6})\s+(.*)/);if(i){var d=i[1].length;t+="<h"+d+">"+M(i[2])+"</h"+d+">",a++}else{for(var p=[];a<n.length&&""!==n[a].trim()&&!n[a].match(/^```/)&&!n[a].match(/^\s*[-*+]\s+/)&&!n[a].match(/^\s*\d+\.\s+/)&&!n[a].match(/^#{1,6}\s+/);)p.push(n[a]),a++;t+="<p>"+M(p.join("\n"))+"</p>"}}else a++}return t}function M(e){e=I(e);return(e=(e=(e=(e=(e=(e=e.replace(/`([^`]+)`/g,"<code>$1</code>")).replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")).replace(/__(.+?)__/g,"<strong>$1</strong>")).replace(/\*(.+?)\*/g,"<em>$1</em>")).replace(/(^|[^\w])_([^_\n]+)_($|[^\w])/g,"$1<em>$2</em>$3")).replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank">$1</a>')).replace(/\n/g,"<br>")}function L(e,t){return t?(e=(e=(e=(e=(e=(e=e.replace(/(\/\/[^\n]*)/g,'<span class="token-comment">$1</span>')).replace(/(\/\*[\s\S]*?\*\/)/g,'<span class="token-comment">$1</span>')).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g,'<span class="token-string">$1</span>')).replace(/(&#x27;(?:[^&]|&(?!#x27;))*?&#x27;)/g,'<span class="token-string">$1</span>')).replace(/('(?:[^'\\]|\\.)*')/g,'<span class="token-string">$1</span>')).replace(/\b(\d+\.?\d*)\b/g,'<span class="token-number">$1</span>')).replace(new RegExp("\\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|implements|interface|type|enum|import|export|from|default|new|this|try|catch|finally|throw|async|await|yield|of|in|typeof|instanceof|void|null|undefined|true|false|def|self|print|elif|except|raise|with|as|pass|lambda|None|True|False|public|private|protected|static|final|abstract|override|readonly|declare)\\b","g"),'<span class="token-keyword">$1</span>'):e}function I(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#x27;")}y&&y.addEventListener("click",function(){e.postMessage({type:"startSpec"})}),window.addEventListener("message",function(s){var c,l,v,h,y,E=s.data;switch(E.type){case"restoreConversation":t.innerHTML="",d=null,p="";if(E.account){const account=document.createElement("div");account.className="system-message";account.textContent=E.account;t.appendChild(account)}for(const entry of E.entries){if(entry.role==="user")b("user").textContent=entry.text;else if(entry.role==="assistant"){const bubble=b("assistant");bubble.innerHTML=C(entry.text);x(bubble)}else if(entry.role==="tool"){const bubble=document.createElement("div");bubble.className="tool-status";bubble.textContent=entry.text;t.appendChild(bubble)}}k();break;case"response":h=E.content,y=E.done,d||(d=b("assistant"),p=""),p+=h,d.innerHTML=C(p),y&&(x(d),d=null,p=""),k();break;case"toolStatus":!function(e,n){if(d&&p&&(d.innerHTML=C(p),x(d),d=null,p=""),"in_progress"!==n||"read"!==e&&"write"!==e&&"shell"!==e){var a="completed"===n?"✓":"⏳",s=document.createElement("div");s.className="tool-status"+("completed"===n?" completed":""),s.textContent=a+" "+e,t.appendChild(s),k()}}(E.title,E.status,E.kind);break;case"error":!function(e){d&&p&&(d.innerHTML=C(p),x(d)),d=null,p="";var t=b("error");t.innerHTML='<span class="error-label">Error:</span> '+I(e)+'<br><button class="error-retry-btn">Retry</button>';var n=t.querySelector(".error-retry-btn");n&&n.addEventListener("click",f),k()}(E.message);break;case"loading":v=E.active,kiroBusy=!!v,document.getElementById("send-btn").disabled=!!v||!o.value,o.disabled=!!v||!o.value,n&&(v?n.classList.remove("hidden"):n.classList.add("hidden")),k();break;case"specPhase":!function(e,t){if(a){a.classList.remove("hidden"),a.innerHTML=["requirements","design","tasks"].map(function(e,n){return'<span class="spec-phase'+(n===t?" active":"")+'">'+I(e)+"</span>"}).join("")}}(E.phase,E.phaseIndex);break;case"specPhaseBar":!function(t,n,s){if(a){if(!s||0===s.length||n<0)return a.classList.add("hidden"),void(a.innerHTML="");a.classList.remove("hidden");for(var c=n===s.length-1,o='<div class="spec-phases-list">',l=0;l<s.length;l++){var r="spec-phase";o+='<span class="'+(r+=l<n?" completed":l===n?" active":" future")+'">'+I(s[l])+"</span>"}o+='<span class="spec-phase-description">Phase '+(n+1)+" of "+s.length+"</span>",o+="</div>";var i='<div class="spec-phase-actions">';i+='<button class="spec-save-only-btn" id="spec-save-only-btn">💾 Save</button>',i+=c?'<button class="spec-accept-btn" id="spec-accept-btn">✅ Save &amp; Finish</button>':'<button class="spec-accept-btn" id="spec-accept-btn">✅ Save &amp; Continue →</button>',i+='<button class="spec-cancel-btn" id="spec-cancel-btn">✕ Cancel</button>',i+="</div>",a.innerHTML=o+i;var d=document.getElementById("spec-save-only-btn"),p=document.getElementById("spec-accept-btn"),u=document.getElementById("spec-cancel-btn");d&&d.addEventListener("click",function(){e.postMessage({type:"specSave"})}),p&&p.addEventListener("click",function(){e.postMessage({type:"specAccept"})}),u&&u.addEventListener("click",function(){e.postMessage({type:"specCancel"})})}}(E.phase,E.phaseIndex,E.phases);break;case"systemMessage":c=E.message,(l=document.createElement("div")).className="system-message",l.textContent=c,t.appendChild(l),k();break;case"configOptions":!function(e){for(var t=null,n=0;n<e.length;n++)if("model"===e[n].category){t=e[n];break}if(t){m=t.id,g=!0,o.innerHTML="",o.disabled=!1,u={};for(var a=0;a<t.options.length;a++){var s=t.options[a],c=document.createElement("option");c.value=s.value,c.textContent=s.name,o.appendChild(c),u[s.name]=s.value}o.value=t.currentValue,o.disabled=kiroBusy,document.getElementById("send-btn").disabled=kiroBusy||!o.value,o.style.display=t.options.length>0?"":"none",g=!1}else{o.innerHTML="<option value=\"\">\u6682\u65e0\u53ef\u7528\u6a21\u578b</option>",o.value="",o.disabled=!0,document.getElementById("send-btn").disabled=!0}}(E.options);break;case"clearChat":t.innerHTML="",d=null,p="";break;case"contextUsage":!function(e){if(r&&i){var t,n=e.total||0,a=2*Math.PI*7,s=n/100*a,c=a-s;r.setAttribute("stroke-dasharray",s+" "+c),t=n<50?"#73c991":n<80?"#cca700":"#f48771",r.setAttribute("stroke",t),i.title="Context usage: "+Math.round(n)+"%";var o=document.getElementById("ctx-conversation"),l=document.getElementById("ctx-mcp"),d=document.getElementById("ctx-steering"),p=document.getElementById("ctx-total");o&&(o.textContent=Math.round(e.conversation||0)),l&&(l.textContent=Math.round(e.mcpTools||0)),d&&(d.textContent=Math.round(e.steeringFiles||0)),p&&(p.textContent=Math.round(n))}}(E.usage)}}),o.addEventListener("change",function(){if(!g){var t=o.value,n=m||"chat.model";e.postMessage({type:"selectModel",configId:n,value:t})}}),s.addEventListener("keydown",function(e){"Enter"!==e.key||e.shiftKey||(e.preventDefault(),h())}),s.addEventListener("input",E),c.addEventListener("click",h),(function setupEffortControls(api) {
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
})(e),(function setupHistoryControls(api) {
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
})(e),e.postMessage({type:"ready"})}();