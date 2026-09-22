(async () => {
    /* ================= CONFIG (via window.__NUDGE_CONFIG__; atualizável em runtime) ================= */
    var IGNORE_NAMES = [];
    var INTERVAL_BETWEEN_CLICKS_MS = 1000;
    var INTERVAL_BETWEEN_LOOPS_MS = 5000;
    var ESSENTIAL_COMMANDS = [':chooser'];
    var ESSENTIAL_COMMANDS_ENABLED = true;
    var ESSENTIAL_COMMANDS_INTERVAL_MS = 5000;
    var ESSENTIAL_BETWEEN_MS = 1500;
    var SCROLL_HARVEST = false;

    function refreshNudgeConfig() {
        var c = (typeof window !== 'undefined' && window.__NUDGE_CONFIG__) || {};
        IGNORE_NAMES = c.ignoreNames || [];
        INTERVAL_BETWEEN_CLICKS_MS = (typeof c.intervalBetweenClicksMs === 'number' && c.intervalBetweenClicksMs >= 100) ? c.intervalBetweenClicksMs : 1000;
        INTERVAL_BETWEEN_LOOPS_MS = (typeof c.intervalBetweenLoopsMs === 'number' && c.intervalBetweenLoopsMs >= 500) ? c.intervalBetweenLoopsMs : 5000;
        ESSENTIAL_COMMANDS = Array.isArray(c.essentialCommands) && c.essentialCommands.length > 0 ? c.essentialCommands : [':chooser'];
        ESSENTIAL_COMMANDS_ENABLED = c.essentialCommandsEnabled !== false;
        ESSENTIAL_COMMANDS_INTERVAL_MS = (typeof c.essentialCommandsIntervalMs === 'number' && c.essentialCommandsIntervalMs >= 1000) ? c.essentialCommandsIntervalMs : 5000;
        ESSENTIAL_BETWEEN_MS = (typeof c.essentialBetweenCommandsMs === 'number' && c.essentialBetweenCommandsMs >= 100) ? c.essentialBetweenCommandsMs : 1500;
        SCROLL_HARVEST = !!c.scrollHarvest;
    }
    refreshNudgeConfig();

    const LIST_SELECTOR = '.user-row';
    const CHAT_SELECTOR = 'input.chat-input[name="chat"]';
    /* ========================================== */

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /* ============ ESTADO ============ */
    let lastChooserTime = 0;
    let cycleCount = 0;
    let clickedLastCycle = 0;

    /* ============ LOGS ============ */
    if (typeof window !== 'undefined') window.__NUDGE_LOGS__ = [];
    const LOG_CAP = 500;
    function log(msg) {
        console.log('[Nudge] ' + msg);
        if (typeof window !== 'undefined' && window.__NUDGE_LOGS__) {
            window.__NUDGE_LOGS__.push({ t: Date.now(), msg: String(msg) });
            if (window.__NUDGE_LOGS__.length > LOG_CAP) window.__NUDGE_LOGS__.shift();
        }
    }

    function updateStats() {
        if (typeof window !== 'undefined') {
            window.__NUDGE_STATS__ = { cycleCount, clickedLastCycle };
        }
    }

    /* ============ UTIL ============ */

    function isIgnored(name) {
        return IGNORE_NAMES.some(n => n.toLowerCase() === name.toLowerCase());
    }

    function userListExists() {
        return document.querySelectorAll(LIST_SELECTOR).length > 0;
    }

    async function sendChatCommand(cmd) {
        const input = document.querySelector(CHAT_SELECTOR);
        if (!input || !input.isConnected) return;
        input.focus();
        input.value = cmd;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(25);
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
        await sleep(60);
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        try { input.blur(); } catch (_) {}
    }

    async function sendChooserCommand() {
        if (!ESSENTIAL_COMMANDS_ENABLED || ESSENTIAL_COMMANDS.length === 0) return;
        const now = Date.now();
        if (now - lastChooserTime < ESSENTIAL_COMMANDS_INTERVAL_MS) return;

        lastChooserTime = now;
        for (const cmd of ESSENTIAL_COMMANDS) {
            await sendChatCommand(cmd);
            await sleep(ESSENTIAL_BETWEEN_MS);
        }
        log('Lista de usuários não visível. Enviando comandos essenciais (:chooser, etc.) para abrir o seletor.');
    }

    async function ensureUserListVisible() {
        if (!userListExists()) {
            await sendChooserCommand();
            return false;
        }
        return true;
    }

    function getVisibleUsers() {
        return [...document.querySelectorAll(LIST_SELECTOR)]
            .map(row => {
                const t = row.querySelectorAll('.row-text');
                return { name: t[0]?.textContent?.trim(), type: t[1]?.textContent?.trim() };
            })
            .filter(u => {
                if (!u.name) return false;
                if (!u.type) return true;
                return /habblet|habbo/i.test(u.type);
            })
            .map(u => u.name);
    }

    function findRowByName(name) {
        return [...document.querySelectorAll(LIST_SELECTOR)]
            .find(row => {
                const t = row.querySelectorAll('.row-text');
                return t[0]?.textContent?.trim() === name;
            }) || null;
    }

    function realClick(el) {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        ['mousedown', 'mouseup', 'click'].forEach(t =>
            el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y }))
        );
        return true;
    }

    function closeMenus() {
        document.body.dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 })
        );
    }

    function getScrollContainer() {
        const first = document.querySelector(LIST_SELECTOR);
        if (!first) return null;
        let el = first.parentElement;
        while (el && el !== document.body) {
            const s = getComputedStyle(el);
            const ox = s.overflowY || s.overflow;
            if (/(auto|scroll|overlay)/.test(ox) && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
        }
        return null;
    }

    async function runScrollHarvest() {
        const container = getScrollContainer();
        if (!container) return;
        container.scrollTop = container.scrollHeight;
        await sleep(220);
        container.scrollTop = 0;
        await sleep(100);
    }

    async function runMiniScroll() {
        const container = getScrollContainer();
        if (!container) return;
        container.scrollTop = container.scrollHeight;
        await sleep(120);
        container.scrollTop = 0;
        await sleep(70);
    }

    /* ============ LOOP PRINCIPAL: clicar 1 a 1, intervalo X entre cliques, repetir a cada Y ============ */

    async function runCycle() {
        if (window.__NUDGE_PAUSE__) return;
        refreshNudgeConfig();

        if (!(await ensureUserListVisible())) return;

        if (SCROLL_HARVEST && getScrollContainer()) await runScrollHarvest();
        else if (getScrollContainer()) await runMiniScroll();

        if (window.__NUDGE_PAUSE__) return;
        if (!(await ensureUserListVisible())) return;

        const users = getVisibleUsers().filter(n => !isIgnored(n));
        clickedLastCycle = 0;

        for (const name of users) {
            if (window.__NUDGE_PAUSE__) break;

            closeMenus();
            await sleep(20);
            if (window.__NUDGE_PAUSE__) break;

            const row = findRowByName(name);
            if (!row) continue;

            row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            await sleep(20);

            const alvo = row.querySelector('.grid') || row;
            if (!realClick(alvo)) continue;

            clickedLastCycle++;
            log('Clicado: ' + name);

            await sleep(100);
            closeMenus();
            await sleep(Math.max(0, INTERVAL_BETWEEN_CLICKS_MS - 100));
        }

        cycleCount++;
        updateStats();
        log('Ciclo ' + cycleCount + ' concluído. Clicados: ' + clickedLastCycle + '. Próximo ciclo em ' + (INTERVAL_BETWEEN_LOOPS_MS / 1000) + 's.');
    }

    async function mainLoop() {
        while (true) {
            if (window.__NUDGE_PAUSE__) {
                await sleep(1000);
                continue;
            }
            try {
                await runCycle();
            } catch (e) {
                log('Erro no ciclo: ' + (e && e.message ? e.message : String(e)));
            }
            await sleep(INTERVAL_BETWEEN_LOOPS_MS);
        }
    }

    mainLoop();

    if (typeof window !== 'undefined') {
        window.__NUDGE_LOADED__ = true;
    }
    updateStats();
    log('Nudge Everyone iniciado. Clica nas pessoas da lista, 1 a 1, com intervalo de ' + (INTERVAL_BETWEEN_CLICKS_MS / 1000) + 's entre cliques. Loop a cada ' + (INTERVAL_BETWEEN_LOOPS_MS / 1000) + 's.');
})();
