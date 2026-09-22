(async () => {
    /* ================= CONFIG (via window.__ADDALL_CONFIG__ ou padrões; atualizável em runtime) ================= */
    var IGNORE_NAMES = ['Dominguez'];
    var CLICK_DELAY = 100;
    var MENU_TIMEOUT = 1200;
    var PROCESS_DELAY = 140;
    var RECONCILE_INTERVAL = 380;
    var MAX_RETRIES = 5;
    var MENU_CLOSE_DELAY = 80;
    var ROW_NOT_FOUND_BACKOFF_MS = 500;
    var FRIEND_BTN_WAIT_MS = 380;
    var SCROLL_HARVEST = false;
    var ESSENTIAL_COMMANDS = [':chooser'];
    var ESSENTIAL_COMMANDS_ENABLED = true;
    var ESSENTIAL_COMMANDS_INTERVAL_MS = 5000;
    var ESSENTIAL_BETWEEN_MS = 1500;
    var AUTO_ROOM = false;

    function refreshAddallConfig() {
        var c = (typeof window !== 'undefined' && window.__ADDALL_CONFIG__) || {};
        IGNORE_NAMES = c.ignoreNames || ['Dominguez'];
        CLICK_DELAY = c.clickDelay ?? 100;
        MENU_TIMEOUT = c.menuTimeout ?? 1200;
        PROCESS_DELAY = c.processDelay ?? 140;
        RECONCILE_INTERVAL = c.reconcileInterval ?? 380;
        MAX_RETRIES = c.maxRetries ?? 5;
        MENU_CLOSE_DELAY = c.menuCloseDelay ?? 80;
        ROW_NOT_FOUND_BACKOFF_MS = c.rowNotFoundBackoffMs ?? 500;
        FRIEND_BTN_WAIT_MS = c.friendBtnWaitMs ?? 380;
        SCROLL_HARVEST = !!c.scrollHarvest;
        ESSENTIAL_COMMANDS = Array.isArray(c.essentialCommands) && c.essentialCommands.length > 0 ? c.essentialCommands : [':chooser'];
        ESSENTIAL_COMMANDS_ENABLED = c.essentialCommandsEnabled !== false;
        ESSENTIAL_COMMANDS_INTERVAL_MS = (typeof c.essentialCommandsIntervalMs === 'number' && c.essentialCommandsIntervalMs >= 1000) ? c.essentialCommandsIntervalMs : 5000;
        ESSENTIAL_BETWEEN_MS = (typeof c.essentialBetweenCommandsMs === 'number' && c.essentialBetweenCommandsMs >= 100) ? c.essentialBetweenCommandsMs : 1500;
        AUTO_ROOM = !!c.autoRoom;
    }
    refreshAddallConfig();

    const LIST_SELECTOR = '.user-row';
    const CHAT_SELECTOR = 'input.chat-input[name="chat"]';
    /* ========================================== */

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /* ============ ESTADO GLOBAL ============ */
    const queue = new Map();
    const processing = new Set();
    const done = new Set();
    const ignored = new Set();
    const notAcceptingRequests = new Set();
    let lastChooserTime = 0;
    let processNextLock = false;
    let reconcileLock = false;
    let autoRoomLock = false;
    let autoRoomCountdownStart = null;
    let autoRoomLastQueueSize = 0;
    let autoRoomVisitedRooms = new Set();

    /* ============ LOGS (para a UI) — nova injeção começa com logs limpos ============ */
    if (typeof window !== 'undefined') window.__ADDALL_LOGS__ = [];
    const LOG_CAP = 500;
    function log(msg) {
        console.log(msg);
        if (typeof window !== 'undefined' && window.__ADDALL_LOGS__) {
            window.__ADDALL_LOGS__.push({ t: Date.now(), msg: String(msg) });
            if (window.__ADDALL_LOGS__.length > LOG_CAP) window.__ADDALL_LOGS__.shift();
        }
    }

    const STATS_CAP = 2000;
    function updateStats() {
        if (typeof window !== 'undefined') {
            var dn = [...done];
            var ig = [...ignored];
            var nar = [...notAcceptingRequests];
            if (dn.length > STATS_CAP) dn = dn.slice(-STATS_CAP);
            if (ig.length > STATS_CAP) ig = ig.slice(-STATS_CAP);
            if (nar.length > STATS_CAP) nar = nar.slice(-STATS_CAP);
            window.__ADDALL_STATS__ = {
                queue: queue.size,
                processing: processing.size,
                done: done.size,
                ignored: ignored.size,
                notAcceptingRequests: notAcceptingRequests.size,
                queueNames: [...queue.keys()],
                processingNames: [...processing],
                doneNames: dn,
                ignoredNames: ig,
                notAcceptingRequestsNames: nar
            };
        }
    }

    /* ============ UTIL ============ */

    function isIgnored(name) {
        return IGNORE_NAMES.some(n => n.toLowerCase() === name.toLowerCase());
    }

    function markAsNotAcceptingRequests(name) {
        ignored.delete(name);
        done.delete(name);
        queue.delete(name);
        notAcceptingRequests.add(name);
    }

    function markAsIgnored(name) {
        if (!notAcceptingRequests.has(name)) {
            done.delete(name);
            queue.delete(name);
            ignored.add(name);
        }
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

        const input = document.querySelector(CHAT_SELECTOR);
        if (!input || !input.isConnected) return;

        lastChooserTime = now;
        for (const cmd of ESSENTIAL_COMMANDS) {
            await sendChatCommand(cmd);
            await sleep(ESSENTIAL_BETWEEN_MS);
        }
        log('Lista de usuários não está visível. Enviando comandos essenciais no chat para abrir o seletor de usuários na sala.');
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
                return {
                    name: t[0]?.textContent?.trim(),
                    type: t[1]?.textContent?.trim()
                };
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
            el.dispatchEvent(new MouseEvent(t, {
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y
            }))
        );
        return true;
    }

    function closeMenus() {
        document.body.dispatchEvent(
            new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                clientX: 1,
                clientY: 1
            })
        );
    }

    function waitForMenu(timeout = MENU_TIMEOUT) {
        return new Promise(res => {
            const start = performance.now();
            const step = 45;
            const check = () => {
                const menu = document.querySelector('.nitro-context-menu.visible');
                if (menu) return res(menu);
                if (performance.now() - start > timeout) return res(null);
                setTimeout(check, step);
            };
            check();
        });
    }

    function findNotAcceptingAlert() {
        const alert = document.querySelector('.nitro-alert');
        if (!alert) return null;
        const text = alert.textContent || '';
        const lowerText = text.toLowerCase();
        if (lowerText.includes('não aceita pedidos de amizade') || 
            lowerText.includes('não aceita solicitações') ||
            (lowerText.includes('não permitido') && lowerText.includes('amizade'))) {
            return alert;
        }
        return null;
    }

    async function closeNotAcceptingAlert() {
        const alert = findNotAcceptingAlert();
        if (!alert) return false;
        const closeBtn = alert.querySelector('.btn-primary, .btn.btn-primary, button.btn-primary, .btn.btn-primary.btn-sm');
        if (closeBtn) {
            realClick(closeBtn);
            await sleep(300);
            const stillOpen = findNotAcceptingAlert();
            if (stillOpen) {
                await sleep(100);
                try { closeBtn.click(); } catch (_) {}
                await sleep(200);
            }
            return true;
        }
        return false;
    }

    async function waitForNotAcceptingAlert(timeout = 2000) {
        return new Promise(res => {
            const start = performance.now();
            const step = 50;
            const check = () => {
                const alert = findNotAcceptingAlert();
                if (alert) return res(true);
                if (performance.now() - start > timeout) return res(false);
                setTimeout(check, step);
            };
            check();
        });
    }

    function getBtnText(b) {
        const t = (b.textContent || '').trim();
        const aria = (b.getAttribute('aria-label') || '').trim();
        const title = (b.getAttribute('title') || '').trim();
        return [t, aria, title].filter(Boolean).join(' ') || t;
    }

    function isDestructive(text) {
        return /remover|desfazer|excluir|remove|delete/i.test(text);
    }

    function matchesFriendRequest(text) {
        if (!text) return false;
        if (text === 'Pedir Amizade') return true;
        if (isDestructive(text)) return false;
        return /(pedir|solicitar|add|enviar|send)(\s*solicita[çc][ãa]o\s*de\s*)?\s*(amizade|friend)/i.test(text) ||
            (/amizade|friend/i.test(text) && /pedir|solicitar|add|enviar|send/i.test(text));
    }

    function isBtnDisabled(b) {
        if (!b || !b.isConnected) return true;
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') return true;
        if (b.classList.contains('disabled') || b.classList.contains('is-disabled')) return true;
        if (b.closest('[disabled]')) return true;
        return false;
    }

    function findFriendBtnIn(root) {
        if (!root || !root.querySelectorAll) return null;
        const selectors = ['.menu-item', '[role="menuitem"]', 'button', 'a', '[class*="menu-item"]'];
        const seen = new Set();
        for (const sel of selectors) {
            try {
                for (const b of root.querySelectorAll(sel)) {
                    if (seen.has(b)) continue;
                    seen.add(b);
                    if (isBtnDisabled(b)) continue;
                    const text = getBtnText(b);
                    if (matchesFriendRequest(text)) return b;
                }
            } catch (_) {}
        }
        return null;
    }

    function findFriendBtn(menu) {
        if (!menu || !menu.isConnected) return null;
        let btn = findFriendBtnIn(menu);
        if (btn) return btn;
        try {
            if (menu.shadowRoot) btn = findFriendBtnIn(menu.shadowRoot);
        } catch (_) {}
        return btn;
    }

    async function waitForFriendBtn(menu, extraMs) {
        const ms = extraMs ?? FRIEND_BTN_WAIT_MS;
        const step = 35;
        let t = 0;
        let btn = findFriendBtn(menu);
        if (btn) return btn;
        while (t < ms) {
            await sleep(step);
            t += step;
            btn = findFriendBtn(menu);
            if (btn) return btn;
        }
        await sleep(120);
        return findFriendBtn(menu);
    }

    async function clickFriendBtn(btn) {
        if (!btn || !btn.isConnected) return;
        try { btn.scrollIntoView({ block: 'nearest', behavior: 'auto' }); } catch (_) {}
        await sleep(35);
        if (!realClick(btn)) {
            await sleep(25);
            if (!realClick(btn)) try { btn.click(); } catch (_) {}
        }
    }

    function getNextFromQueue() {
        const now = Date.now();
        for (const [name, state] of queue.entries()) {
            if (state.backoffUntil && state.backoffUntil > now) continue;
            return [name, state];
        }
        return null;
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

    /* ============ RECONCILIAÇÃO (lock evita corrida entre execuções) ============ */

    async function reconcileQueue() {
        if (window.__ADDALL_PAUSE__) return;
        refreshAddallConfig();
        if (reconcileLock) return;
        reconcileLock = true;
        try {
            if (!(await ensureUserListVisible())) return;

            /* Só faz scroll de descoberta quando há fila ou processamento; com fila vazia
               o scroll contínuo deixa a lista bugada (seleção aleatória, foco em linhas). */
            if (queue.size > 0 || processing.size > 0) {
                if (SCROLL_HARVEST) {
                    await runScrollHarvest();
                } else if (getScrollContainer()) {
                    await runMiniScroll();
                }
            }
            if (window.__ADDALL_PAUSE__) return;
            if (!(await ensureUserListVisible())) return;

            const visible = new Set(getVisibleUsers());

            for (const name of [...queue.keys()]) {
                if (!visible.has(name) && !processing.has(name)) queue.delete(name);
            }

            for (const name of visible) {
                if (isIgnored(name)) {
                    if (!ignored.has(name)) log('Ignorado (lista de exclusão): ' + name + ' — nome está na sua configuração de nomes a ignorar.');
                    markAsIgnored(name);
                    continue;
                }
                if (ignored.has(name) || done.has(name) || processing.has(name) || notAcceptingRequests.has(name)) continue;
                if (!queue.has(name)) {
                    queue.set(name, { retries: 0, retriesFind: 0 });
                    log('Adicionado à fila: ' + name + ' — usuário encontrado na lista, aguardando envio de pedido de amizade.');
                }
            }
        } finally {
            reconcileLock = false;
        }
    }

    setInterval(reconcileQueue, RECONCILE_INTERVAL);
    reconcileQueue();

    /* ============ PROCESSAMENTO (um por vez, com lock) ============ */

    async function processNext() {
        if (window.__ADDALL_PAUSE__) return;
        refreshAddallConfig();
        const next = getNextFromQueue();
        if (!next) return;

        const [name, state] = next;
        if (processNextLock) return;
        processNextLock = true;
        queue.delete(name);
        processing.add(name);

        try {
            const row = findRowByName(name);

            if (!row) {
                const vis = new Set(getVisibleUsers());
                if (!vis.has(name)) {
                    log('Removido da fila: ' + name + ' — não está mais na lista visível.');
                    return;
                }
                state.backoffUntil = Date.now() + ROW_NOT_FOUND_BACKOFF_MS;
                queue.set(name, state);
                log('Linha não encontrada (pode ter saído da vista): ' + name + ' — nova tentativa em ' + (ROW_NOT_FOUND_BACKOFF_MS / 1000) + 's.');
                return;
            }

            closeMenus();
            await sleep(MENU_CLOSE_DELAY);
            if (window.__ADDALL_PAUSE__) { queue.set(name, state); return; }

            row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            await sleep(20);
            if (window.__ADDALL_PAUSE__) { queue.set(name, state); return; }

            const alvo = row.querySelector('.grid') || row;
            if (!realClick(alvo)) {
                state.retries = (state.retries ?? 0) + 1;
                if ((state.retries ?? 0) < MAX_RETRIES) { queue.set(name, state); log('Clique na linha falhou: ' + name + ' (' + (state.retries || 0) + '/' + MAX_RETRIES + ' tentativas de clique).'); }
                else { markAsIgnored(name); log('Ignorado: ' + name + ' — clique na linha falhou após ' + MAX_RETRIES + ' tentativas.'); }
                return;
            }

            const menu = await waitForMenu();
            if (window.__ADDALL_PAUSE__) { queue.set(name, state); return; }

            const btn = await waitForFriendBtn(menu);
            if (window.__ADDALL_PAUSE__) { queue.set(name, state); return; }

            const menuAindaVisivel = menu && document.querySelector('.nitro-context-menu.visible') === menu;
            const btnValido = btn && btn.isConnected && !isBtnDisabled(btn) && menuAindaVisivel;

            if (!btnValido) {
                state.retriesFind = (state.retriesFind ?? 0) + 1;
                if ((state.retriesFind ?? 0) < MAX_RETRIES) {
                    queue.set(name, state);
                    log('Aguardando nova tentativa: ' + name + ' (' + (state.retriesFind || 0) + '/' + MAX_RETRIES + ' tentativas de achar o botão) — "Pedir Amizade" não apareceu no menu.');
                } else {
                    markAsIgnored(name);
                    log('Ignorado: ' + name + ' — o botão "Pedir Amizade" não apareceu após ' + MAX_RETRIES + ' tentativas (a pessoa pode já ser sua amiga ou o botão estar indisponível).');
                }
                return;
            }

            const toClick = findFriendBtn(menu) || btn;
            if (!toClick || !toClick.isConnected) {
                state.retriesFind = (state.retriesFind ?? 0) + 1;
                if ((state.retriesFind ?? 0) < MAX_RETRIES) { queue.set(name, state); log('Botão "Pedir Amizade" não encontrado no momento do clique: ' + name + ' (' + (state.retriesFind || 0) + '/' + MAX_RETRIES + ' tentativas de achar).'); }
                else { markAsIgnored(name); log('Ignorado: ' + name + ' — botão inválido antes do clique após ' + MAX_RETRIES + ' tentativas de achar.'); }
                return;
            }

            await clickFriendBtn(toClick);
            if (window.__ADDALL_PAUSE__) { queue.set(name, state); return; }

            await sleep(CLICK_DELAY);
            if (window.__ADDALL_PAUSE__) { queue.set(name, state); return; }

            const alertAppeared = await waitForNotAcceptingAlert(2000);
            if (alertAppeared) {
                await closeNotAcceptingAlert();
                markAsNotAcceptingRequests(name);
                log('Usuário não aceita solicitações: ' + name + ' — este Habblet não aceita pedidos de amizade.');
                return;
            }

            var menuAindaAberto = document.querySelector('.nitro-context-menu.visible') === menu;
            if (menuAindaAberto) {
                await sleep(70);
                if (document.querySelector('.nitro-context-menu.visible') === menu) {
                    try { toClick.click(); } catch (_) {}
                    await sleep(100);
                    
                    const alertAfterClick = await waitForNotAcceptingAlert(1000);
                    if (alertAfterClick) {
                        await closeNotAcceptingAlert();
                        markAsNotAcceptingRequests(name);
                        log('Usuário não aceita solicitações: ' + name + ' — este Habblet não aceita pedidos de amizade.');
                        return;
                    }
                    
                    if (document.querySelector('.nitro-context-menu.visible') !== menu) {
                        log('Pedido de amizade enviado: ' + name);
                        done.add(name);
                        return;
                    }
                }
                menuAindaAberto = document.querySelector('.nitro-context-menu.visible') === menu;
            }
            if (menuAindaAberto) {
                const finalAlertCheck = await waitForNotAcceptingAlert(500);
                if (finalAlertCheck) {
                    await closeNotAcceptingAlert();
                    markAsNotAcceptingRequests(name);
                    log('Usuário não aceita solicitações: ' + name + ' — este Habblet não aceita pedidos de amizade.');
                    return;
                }
                
                state.retries = (state.retries ?? 0) + 1;
                if ((state.retries ?? 0) < MAX_RETRIES) {
                    queue.set(name, state);
                    log('Menu não fechou após o clique (pedido pode não ter sido enviado): ' + name + ' (' + (state.retries || 0) + '/' + MAX_RETRIES + ' tentativas de clique).');
                } else {
                    markAsIgnored(name);
                    if (!notAcceptingRequests.has(name)) {
                        log('Ignorado: ' + name + ' — o menu não fechou após o clique em ' + MAX_RETRIES + ' tentativas (pedido pode não ter sido enviado).');
                    }
                }
                return;
            }

            log('Pedido de amizade enviado: ' + name);
            done.add(name);

        } catch (err) {
            state.retries = (state.retries ?? 0) + 1;
            if ((state.retries ?? 0) < MAX_RETRIES) {
                queue.set(name, state);
                log('Erro inesperado: ' + name + ' — nova tentativa (' + (state.retries || 0) + '/' + MAX_RETRIES + ').');
            } else {
                markAsIgnored(name);
                log('Ignorado: ' + name + ' — erro após ' + MAX_RETRIES + ' tentativas.');
            }
        } finally {
            processNextLock = false;
            processing.delete(name);
            setTimeout(processNext, PROCESS_DELAY);
        }
    }

    setInterval(processNext, 100);

    /* ============ AUTO ROOM ============ */

    function isNavigatorOpen() {
        const navigator = document.querySelector('.nitro-navigator');
        if (!navigator) return false;
        const style = window.getComputedStyle(navigator);
        return style.visibility !== 'hidden' && style.display !== 'none';
    }

    async function openNavigator() {
        if (isNavigatorOpen()) return true;
        const btn = document.querySelector('.navigation-item.icon.icon-rooms, div.cursor-pointer.navigation-item.icon.icon-rooms, [class*="icon-navigator"], [class*="navigator-icon"], button[aria-label*="navegador" i], button[title*="navegador" i]');
        if (btn) {
            realClick(btn);
            await sleep(500);
            return isNavigatorOpen();
        }
        return false;
    }

    async function clickAllRoomsTab() {
        if (!isNavigatorOpen()) {
            if (!(await openNavigator())) {
                log('Auto Room: Não foi possível abrir o navegador.');
                return false;
            }
            await sleep(500);
        }

        const menu = document.querySelector('.nitro-navigator .menu');
        if (!menu) {
            log('Auto Room: Menu do navegador não encontrado.');
            return false;
        }

        const tabs = menu.querySelectorAll('.btn');
        let foundTab = null;
        for (const tab of tabs) {
            const text = tab.textContent?.trim() || '';
            if (text.includes('Todos os quartos') || text.includes('Todos os Quartos')) {
                foundTab = tab;
                break;
            }
        }

        if (!foundTab) {
            log('Auto Room: Aba "Todos os quartos" não encontrada.');
            return false;
        }

        if (!foundTab.classList.contains('active')) {
            realClick(foundTab);
            await sleep(1000);
            log('Auto Room: Clicou em "Todos os quartos".');
        }
        return true;
    }

    function getRoomIdentifier(roomElement) {
        const nameElement = roomElement.querySelector('.ubuntu-custom, .text-truncate, [class*="room-name"]');
        const name = nameElement ? nameElement.textContent?.trim() : '';
        return name || roomElement.textContent?.trim() || '';
    }

    function getClickableRooms() {
        const rooms = [];
        const seen = new Set();
        const grids = document.querySelectorAll('.navigator-grid');
        
        for (const grid of grids) {
            const items = grid.querySelectorAll('.navigator-item');
            for (const item of items) {
                const hasLocked = item.querySelector('.icon-navigator-room-locked, i.icon-navigator-room-locked');
                const hasPassword = item.querySelector('.icon-navigator-room-password, i.icon-navigator-room-password');
                if (hasLocked || hasPassword) continue;
                
                const identifier = getRoomIdentifier(item);
                if (!identifier) continue;
                
                if (!seen.has(identifier)) {
                    seen.add(identifier);
                    rooms.push({ element: item, identifier: identifier });
                }
            }
        }
        return rooms;
    }

    async function enterRoom(roomElement, roomIdentifier) {
        if (!roomElement || !roomElement.isConnected) return false;
        try {
            roomElement.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            await sleep(200);
            if (realClick(roomElement)) {
                await sleep(1000);
                if (roomIdentifier) {
                    autoRoomVisitedRooms.add(roomIdentifier);
                    log('Auto Room: Entrou no quarto: ' + roomIdentifier);
                } else {
                    log('Auto Room: Entrou no quarto.');
                }
                return true;
            }
        } catch (err) {
            log('Auto Room: Erro ao entrar no quarto: ' + err);
        }
        return false;
    }

    async function waitForQueueToFinish() {
        const maxWait = 300000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            if (window.__ADDALL_PAUSE__ || !AUTO_ROOM) return;
            refreshAddallConfig();
            if (queue.size === 0 && processing.size === 0) {
                return true;
            }
            await sleep(500);
        }
        return false;
    }

    async function waitForCountdown() {
        const COUNTDOWN_MS = 5000;
        const CHECK_INTERVAL = 200;
        const MAX_WAIT = 600000;
        const startTime = Date.now();
        
        if (autoRoomCountdownStart === null) {
            autoRoomCountdownStart = Date.now();
            autoRoomLastQueueSize = queue.size + processing.size;
        }

        while (Date.now() - startTime < MAX_WAIT) {
            if (window.__ADDALL_PAUSE__ || !AUTO_ROOM) {
                autoRoomCountdownStart = null;
                return false;
            }
            refreshAddallConfig();

            const currentTotal = queue.size + processing.size;
            const elapsed = Date.now() - autoRoomCountdownStart;

            if (currentTotal > autoRoomLastQueueSize) {
                log('Auto Room: Alguém entrou na fila (' + currentTotal + '). Reiniciando contagem regressiva.');
                autoRoomCountdownStart = Date.now();
                autoRoomLastQueueSize = currentTotal;
            } else if (currentTotal < autoRoomLastQueueSize) {
                autoRoomLastQueueSize = currentTotal;
            }

            if (elapsed >= COUNTDOWN_MS) {
                if (queue.size === 0 && processing.size === 0) {
                    log('Auto Room: Contagem regressiva concluída (5s). Fila vazia. Prosseguindo para próximo quarto.');
                    autoRoomCountdownStart = null;
                    return true;
                } else {
                    autoRoomCountdownStart = Date.now();
                    autoRoomLastQueueSize = queue.size + processing.size;
                }
            }

            await sleep(CHECK_INTERVAL);
        }
        
        autoRoomCountdownStart = null;
        return false;
    }

    async function runAutoRoom() {
        if (window.__ADDALL_PAUSE__ || !AUTO_ROOM || autoRoomLock) return;
        refreshAddallConfig();
        if (!AUTO_ROOM) {
            autoRoomCountdownStart = null;
            autoRoomVisitedRooms.clear();
            return;
        }

        autoRoomLock = true;
        try {
            const hasQueue = queue.size > 0 || processing.size > 0;
            
            if (hasQueue) {
                autoRoomCountdownStart = null;
                await waitForQueueToFinish();
                if (window.__ADDALL_PAUSE__ || !AUTO_ROOM) return;
            }

            if (queue.size === 0 && processing.size === 0) {
                const countdownReady = await waitForCountdown();
                if (!countdownReady || window.__ADDALL_PAUSE__ || !AUTO_ROOM) return;

                if (!(await openNavigator())) {
                    log('Auto Room: Não foi possível abrir o navegador.');
                    await sleep(2000);
                    return;
                }

                await sleep(500);

                if (!(await clickAllRoomsTab())) {
                    await sleep(2000);
                    return;
                }

                await sleep(1000);
                const allRooms = getClickableRooms();

                if (allRooms.length === 0) {
                    log('Auto Room: Nenhum quarto clicável encontrado. Tentando atualizar a lista...');
                    await clickAllRoomsTab();
                    await sleep(2000);
                    const retryRooms = getClickableRooms();
                    if (retryRooms.length === 0) {
                        await sleep(3000);
                        return;
                    }
                }

                const unvisitedRooms = allRooms.filter(room => !autoRoomVisitedRooms.has(room.identifier));

                if (unvisitedRooms.length === 0) {
                    log('Auto Room: Todos os quartos disponíveis foram visitados. Reiniciando ciclo...');
                    autoRoomVisitedRooms.clear();
                    await clickAllRoomsTab();
                    await sleep(2000);
                    const refreshedRooms = getClickableRooms();
                    const newUnvisitedRooms = refreshedRooms.filter(room => !autoRoomVisitedRooms.has(room.identifier));
                    
                    if (newUnvisitedRooms.length === 0) {
                        log('Auto Room: Nenhum quarto novo encontrado. Aguardando...');
                        await sleep(5000);
                        return;
                    }
                    
                    const roomToVisit = newUnvisitedRooms[0];
                    if (roomToVisit.element && roomToVisit.element.isConnected) {
                        if (await enterRoom(roomToVisit.element, roomToVisit.identifier)) {
                            log('Auto Room: Quarto visitado: ' + roomToVisit.identifier);
                            await sleep(2000);
                        } else {
                            log('Auto Room: Falha ao entrar no quarto: ' + roomToVisit.identifier);
                        }
                    }
                } else {
                    const roomToVisit = unvisitedRooms[0];
                    if (roomToVisit.element && roomToVisit.element.isConnected) {
                        if (await enterRoom(roomToVisit.element, roomToVisit.identifier)) {
                            log('Auto Room: Quarto visitado: ' + roomToVisit.identifier + ' (' + unvisitedRooms.length + ' restantes)');
                            await sleep(2000);
                        } else {
                            log('Auto Room: Falha ao entrar no quarto: ' + roomToVisit.identifier);
                        }
                    } else {
                        log('Auto Room: Quarto não está mais disponível: ' + roomToVisit.identifier);
                        autoRoomVisitedRooms.add(roomToVisit.identifier);
                    }
                }
            }
        } catch (err) {
            log('Auto Room: Erro: ' + err);
        } finally {
            autoRoomLock = false;
        }
    }

    setInterval(runAutoRoom, 2000);

    /* ============ EXPOSIÇÃO DE ESTATÍSTICAS ============ */
    setInterval(updateStats, 300);
    updateStats();

    if (typeof window !== 'undefined') {
        window.__ADDALL_LOADED__ = true;
    }
    log('Script iniciado. A lista de usuários será monitorada e os pedidos de amizade enviados automaticamente.');
})();
