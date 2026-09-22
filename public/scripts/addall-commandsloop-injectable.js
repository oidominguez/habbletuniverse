(async () => {
    /* ================= CONFIG (via window.__ADDALL_COMMANDSLOOP_CONFIG__; atualizável em runtime) ================= */
    var EXTRA_COMMANDS = [];
    var EXTRA_COMMANDS_INTERVAL_MS = 60000;
    var EXTRA_BETWEEN_MS = 2000;

    function refreshCommandsLoopConfig() {
        var c = (typeof window !== 'undefined' && window.__ADDALL_COMMANDSLOOP_CONFIG__) || {};
        EXTRA_COMMANDS = Array.isArray(c.extraCommands) ? c.extraCommands : [];
        EXTRA_COMMANDS_INTERVAL_MS = (typeof c.extraCommandsIntervalMs === 'number' && c.extraCommandsIntervalMs >= 1000) ? c.extraCommandsIntervalMs : 60000;
        EXTRA_BETWEEN_MS = (typeof c.extraBetweenCommandsMs === 'number' && c.extraBetweenCommandsMs >= 100) ? c.extraBetweenCommandsMs : 2000;
    }
    refreshCommandsLoopConfig();

    const CHAT_SELECTOR = 'input.chat-input[name="chat"]';
    var __version = (typeof window !== 'undefined' && (window.__ADDALL_COMMANDSLOOP_VERSION__ = (window.__ADDALL_COMMANDSLOOP_VERSION__ || 0) + 1));
    /* ========================================== */

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function sendChatCommand(cmd) {
        const input = document.querySelector(CHAT_SELECTOR);
        if (!input || !input.isConnected) return;
        input.focus();
        input.value = cmd;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(50);
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
        await sleep(150);
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function runExtraCommands() {
        if (typeof window !== 'undefined' && window.__ADDALL_COMMANDSLOOP_ENABLED__ === false) return;
        refreshCommandsLoopConfig();
        if (EXTRA_COMMANDS.length === 0) return;
        if (typeof window !== 'undefined' && window.__ADDALL_COMMANDSLOOP_LOCK__) return;
        if (typeof window !== 'undefined') window.__ADDALL_COMMANDSLOOP_LOCK__ = true;
        try {
            for (let i = 0; i < EXTRA_COMMANDS.length; i++) {
                if (typeof window !== 'undefined' && window.__ADDALL_COMMANDSLOOP_ENABLED__ === false) break;
                await sendChatCommand(EXTRA_COMMANDS[i]);
                if (i < EXTRA_COMMANDS.length - 1) await sleep(EXTRA_BETWEEN_MS);
            }
        } finally {
            if (typeof window !== 'undefined') window.__ADDALL_COMMANDSLOOP_LOCK__ = false;
        }
    }

    function runAndReschedule() {
        refreshCommandsLoopConfig();
        runExtraCommands().then(function () {
            refreshCommandsLoopConfig();
            if (typeof window !== 'undefined' && window.__ADDALL_COMMANDSLOOP_ENABLED__ !== false && EXTRA_COMMANDS.length > 0 && window.__ADDALL_COMMANDSLOOP_VERSION__ === __version) {
                setTimeout(runAndReschedule, EXTRA_COMMANDS_INTERVAL_MS);
            }
        });
    }

    function start() {
        if (EXTRA_COMMANDS.length === 0 || (typeof window !== 'undefined' && window.__ADDALL_COMMANDSLOOP_ENABLED__ === false)) return;
        if (typeof window !== 'undefined' && window.__ADDALL_COMMANDSLOOP_LOCK__) {
            setTimeout(start, 100);
            return;
        }
        runAndReschedule();
    }

    if (typeof window !== 'undefined') {
        window.__ADDALL_COMMANDSLOOP_LOADED__ = true;
        window.__ADDALL_COMMANDSLOOP_START__ = start;
    }

    start();
})();
