(function () {
    'use strict';
    if (typeof window !== 'undefined' && window.__ADDALL_AUTOREPLY_WHISPERS_INTERVAL__) {
        clearInterval(window.__ADDALL_AUTOREPLY_WHISPERS_INTERVAL__);
        window.__ADDALL_AUTOREPLY_WHISPERS_INTERVAL__ = null;
    }

    var CHAT = 'input.chat-input[name="chat"]';
    var BUBBLE = '.chat-bubble.type-1';
    var ROOT = '.nitro-chat-widget';
    var queue = [];
    var running = false;
    var DELAY_MS = 400;

    function log(m) {
        try {
            if (typeof window === 'undefined') return;
            if (!window.__ADDALL_AUTOREPLY_WHISPERS_LOGS__) window.__ADDALL_AUTOREPLY_WHISPERS_LOGS__ = [];
            window.__ADDALL_AUTOREPLY_WHISPERS_LOGS__.push({ t: Date.now(), msg: m });
            if (window.__ADDALL_AUTOREPLY_WHISPERS_LOGS__.length > 200) window.__ADDALL_AUTOREPLY_WHISPERS_LOGS__.splice(0, 100);
            if (!window.__ADDALL_LOGS__) window.__ADDALL_LOGS__ = [];
            window.__ADDALL_LOGS__.push({ t: Date.now(), msg: '[ARW] ' + m });
        } catch (e) {}
    }

    function cfg() {
        var c = (typeof window !== 'undefined' && window.__ADDALL_AUTOREPLY_WHISPERS_CONFIG__) || {};
        return {
            message: (typeof c.message === 'string') ? c.message : '',
            hideMessage: !!c.hideMessage,
            prefix: (typeof c.alternationPrefix === 'string') ? c.alternationPrefix : '- '
        };
    }

    function enabled() {
        return typeof window !== 'undefined' && window.__ADDALL_AUTOREPLY_WHISPERS_ENABLED__ === true;
    }

    function send(cmd) {
        var el = document.querySelector(CHAT);
        if (!el || !el.isConnected) return Promise.resolve();
        var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        var setVal = set && set.set ? function (v) { set.set.call(el, v); } : function (v) { el.value = v; };
        el.focus();
        setVal('');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        setVal(cmd);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return new Promise(function (r) { setTimeout(r, 120); }).then(function () {
            el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
            return new Promise(function (r) { setTimeout(r, 150); });
        }).then(function () {
            setVal('');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    function userName(bubble) {
        var el = bubble.querySelector('.chat-content .username');
        return (el && el.textContent) ? el.textContent.replace(/\s*:\s*$/, '').trim() : '';
    }

    function run() {
        if (running || queue.length === 0 || !enabled()) return;
        running = true;
        var it = queue.shift();
        var msg = it.message || '';
        var n = (typeof window !== 'undefined' ? (window.__ADDALL_AUTOREPLY_WHISPERS_N__ | 0) : 0);
        var pre = cfg().prefix || '-';
        var text = (n % 2 === 0) ? msg : (pre + msg);
        if (typeof window !== 'undefined') window.__ADDALL_AUTOREPLY_WHISPERS_N__ = n + 1;
        var cmd = 'Sussurrar ' + it.username + ' ' + text;
        log('n=' + n + ' cmd=' + cmd);
        send(cmd).then(function () {
            if (it.hideMessage && it.bubble) {
                var wrap = it.bubble.closest('.bubble-container');
                if (wrap) wrap.style.display = 'none';
            }
            running = false;
            return new Promise(function (r) { setTimeout(r, DELAY_MS); });
        }).then(run).catch(function (e) {
            log('err: ' + (e && e.message ? e.message : String(e)));
            running = false;
            run();
        });
    }

    function isOwnBubble(bubble) {
        var prev = bubble.previousElementSibling;
        if (!prev || !prev.classList || !prev.classList.contains('user-container-bg')) return false;
        var bg = (prev.style && prev.style.backgroundColor) || '';
        if (!bg && typeof window.getComputedStyle === 'function') bg = (window.getComputedStyle(prev).backgroundColor || '');
        var m = String(bg).match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
        if (!m) return false;
        var r = parseInt(m[1], 10), g = parseInt(m[2], 10), b = parseInt(m[3], 10);
        return (r >= 250 && g >= 250 && b >= 250);
    }

    function onBubble(bubble) {
        if (bubble.getAttribute('data-arw-done') || !enabled()) return;
        if (isOwnBubble(bubble)) return;
        var u = userName(bubble);
        if (!u) { log('skip: sem nick'); return; }
        bubble.setAttribute('data-arw-done', '1');
        var c = cfg();
        queue.push({ username: u, bubble: bubble, message: c.message || '', hideMessage: !!c.hideMessage });
        log('enq ' + u + ' q=' + queue.length);
        run();
    }

    function collect(n) {
        var out = [];
        if (!n || n.nodeType !== 1) return out;
        if (n.matches && n.matches(BUBBLE)) { out.push(n); return out; }
        if (n.querySelectorAll) { var all = n.querySelectorAll(BUBBLE); for (var i = 0; i < all.length; i++) out.push(all[i]); }
        return out;
    }

    function onMut(mut) {
        if (!enabled()) return;
        var seen = {};
        for (var m = 0; m < mut.length; m++) {
            var nodes = mut[m].addedNodes;
            for (var i = 0; i < nodes.length; i++) {
                var list = collect(nodes[i]);
                for (var j = 0; j < list.length; j++) {
                    var el = list[j];
                    if (el.getAttribute('data-arw-done') || seen[el]) continue;
                    seen[el] = 1;
                    onBubble(el);
                }
            }
        }
    }

    function attach(root) {
        if (!root) return;
        if (root._arwObs && root._arwObs.disconnect) root._arwObs.disconnect();
        root._arwObs = null;
        var ob = new MutationObserver(onMut);
        ob.observe(root, { childList: true, subtree: true });
        root._arwObs = ob;
    }

    function loop() {
        if (!enabled()) return;
        var r = document.querySelector(ROOT) || document.querySelector('#nitro-chat-widget');
        if (r) attach(r);
    }

    loop();
    var tick = 0, id = setInterval(function () {
        if (!enabled()) { clearInterval(id); if (typeof window !== 'undefined') window.__ADDALL_AUTOREPLY_WHISPERS_INTERVAL__ = null; return; }
        loop();
        var r = document.querySelector(ROOT) || document.querySelector('#nitro-chat-widget');
        if (r) { clearInterval(id); if (typeof window !== 'undefined') window.__ADDALL_AUTOREPLY_WHISPERS_INTERVAL__ = null; return; }
        if (++tick > 60) { clearInterval(id); if (typeof window !== 'undefined') window.__ADDALL_AUTOREPLY_WHISPERS_INTERVAL__ = null; return; }
    }, 1000);
    if (typeof window !== 'undefined') window.__ADDALL_AUTOREPLY_WHISPERS_INTERVAL__ = id;
})();
