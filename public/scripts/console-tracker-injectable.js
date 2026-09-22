(function () {
    'use strict';
    
    function log(m) {
        try {
            if (typeof window === 'undefined') return;
            if (!window.__CONSOLE_TRACKER_LOGS__) window.__CONSOLE_TRACKER_LOGS__ = [];
            var timestamp = new Date().toLocaleTimeString();
            var logMsg = '[' + timestamp + '] ' + m;
            window.__CONSOLE_TRACKER_LOGS__.push({ t: Date.now(), msg: logMsg });
            if (window.__CONSOLE_TRACKER_LOGS__.length > 200) window.__CONSOLE_TRACKER_LOGS__.splice(0, 100);
            if (!window.__ADDALL_LOGS__) window.__ADDALL_LOGS__ = [];
            window.__ADDALL_LOGS__.push({ t: Date.now(), msg: '[CT] ' + logMsg });
        } catch (e) {}
    }
    
    // Prevenir execução duplicada
    if (typeof window !== 'undefined' && window.__CONSOLE_TRACKER_LOADED__) {
        if (typeof window !== 'undefined' && window.__CONSOLE_TRACKER_INTERVAL__) {
            clearInterval(window.__CONSOLE_TRACKER_INTERVAL__);
            window.__CONSOLE_TRACKER_INTERVAL__ = null;
        }
    }
    if (typeof window !== 'undefined') {
        window.__CONSOLE_TRACKER_LOADED__ = true;
    }
    
    if (typeof window !== 'undefined' && window.__CONSOLE_TRACKER_INTERVAL__) {
        clearInterval(window.__CONSOLE_TRACKER_INTERVAL__);
        window.__CONSOLE_TRACKER_INTERVAL__ = null;
    }

    var MESSAGE_BUTTON = '.navigation-item.icon.icon-message, div.cursor-pointer.navigation-item.icon.icon-message';
    var MESSENGER_WINDOW = '.nitro-friends-messenger';
    var MESSENGER_ITEM = '.layout-grid-item-messenger';
    var MESSENGER_CLOSE = '.nitro-card-header-close';
    var CHAT_INPUT = '.chat-input-form';
    var CHAT_SUBMIT = '.chat-submit';
    var CLEAR_BUTTON = '.clear';
    
    var isProcessing = false;
    var hasClearedOnStart = false;
    var lastProcessedTime = 0;
    var processedUsersSet = new Set();
    var consecutiveErrors = 0;
    var lastErrorTime = 0;

    function cfg() {
        var c = (typeof window !== 'undefined' && window.__CONSOLE_TRACKER_CONFIG__) || {};
        return {
            enabled: c.enabled !== false,
            message: (typeof c.message === 'string') ? c.message : '',
            prefix: (typeof c.alternationPrefix === 'string') ? c.alternationPrefix : '- ',
            clearAllOnStart: c.clearAllOnStart !== false,
            autoCloseAfterClear: c.autoCloseAfterClear !== false,
            delayBetweenActions: Math.max((typeof c.delayBetweenActions === 'number') ? c.delayBetweenActions : 200, 100),
            delayAfterClear: Math.max((typeof c.delayAfterClear === 'number') ? c.delayAfterClear : 150, 100),
            delayAfterSelect: Math.max((typeof c.delayAfterSelect === 'number') ? c.delayAfterSelect : 300, 150),
            respondOnlyToNewMessages: c.respondOnlyToNewMessages !== false
        };
    }

    function enabled() {
        return typeof window !== 'undefined' && window.__CONSOLE_TRACKER_ENABLED__ === true && cfg().enabled;
    }

    function realClick(el) {
        if (!el || !el.isConnected) return false;
        try {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            ['mousedown', 'mouseup', 'click'].forEach(t =>
                el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y }))
            );
            return true;
        } catch (err) {
            return false;
        }
    }

    function sleep(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    function hasMessageButton() {
        return document.querySelector(MESSAGE_BUTTON) !== null;
    }

    function isMessengerOpen() {
        var messenger = document.querySelector(MESSENGER_WINDOW);
        if (!messenger) return false;
        var style = window.getComputedStyle(messenger);
        return style.visibility !== 'hidden' && style.display !== 'none';
    }

    async function openMessenger() {
        if (isMessengerOpen()) return true;
        var btn = document.querySelector(MESSAGE_BUTTON);
        if (!btn || !realClick(btn)) return false;
        for (var i = 0; i < 8; i++) {
            await sleep(100);
            if (isMessengerOpen()) return true;
        }
        return false;
    }

    async function closeMessenger() {
        if (!isMessengerOpen()) return true;
        var closeBtn = document.querySelector(MESSENGER_CLOSE);
        if (!closeBtn || !realClick(closeBtn)) return false;
        await sleep(150);
        return !isMessengerOpen();
    }

    function getAllUsers() {
        var users = [];
        var messenger = document.querySelector(MESSENGER_WINDOW);
        if (!messenger) return users;

        var items = messenger.querySelectorAll(MESSENGER_ITEM);
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item || !item.isConnected) continue;
            
            var isActive = item.classList.contains('active');
            var badge = item.querySelector('.nitro-item-count') || item.querySelector('.badge');
            var badgeCount = 0;
            if (badge) {
                badgeCount = parseInt(badge.textContent || '0', 10);
                if (isNaN(badgeCount) || badgeCount <= 0) badgeCount = 0;
                else {
                    var style = window.getComputedStyle(badge);
                    if (style.display === 'none' || style.visibility === 'hidden') badgeCount = 0;
                }
            }
            users.push({ element: item, index: i, isActive: isActive, badgeCount: badgeCount, hasBadge: badgeCount > 0 });
        }
        return users;
    }

    async function selectUser(userItem) {
        if (!userItem || !userItem.element || !userItem.element.isConnected) return false;
        try {
            if (!userItem.isActive) {
                userItem.element.scrollIntoView({ block: 'nearest', behavior: 'auto' });
                await sleep(30);
                if (!realClick(userItem.element)) return false;
                await sleep(150);
            }
            return true;
        } catch (err) {
            return false;
        }
    }

    async function clearChat() {
        var clearBtn = document.querySelector(CLEAR_BUTTON);
        if (!clearBtn || !clearBtn.isConnected || !realClick(clearBtn)) return false;
        await sleep(80);
        return true;
    }

    async function sendMessage(message) {
        var input = document.querySelector(CHAT_INPUT);
        var submit = document.querySelector(CHAT_SUBMIT);
        if (!input || !input.isConnected || !submit || !submit.isConnected) return false;

        try {
            input.focus();
            await sleep(20);
            
            var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            var setVal = set && set.set ? function (v) { set.set.call(input, v); } : function (v) { input.value = v; };
            
            setVal(message);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(80);
            
            if (!realClick(submit)) return false;
            await sleep(120);
            
            setVal('');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        } catch (err) {
            return false;
        }
    }

    async function clearAllChats() {
        if (!isMessengerOpen()) {
            if (!hasMessageButton() || !(await openMessenger())) return false;
            await sleep(400);
        }

        var users = getAllUsers();
        if (users.length === 0) {
            if (cfg().autoCloseAfterClear) await closeMessenger();
            return true;
        }

        var c = cfg();
        for (var i = 0; i < users.length; i++) {
            if (await selectUser(users[i])) {
                await sleep(c.delayAfterSelect);
                await clearChat();
                await sleep(c.delayAfterClear);
            }
            if (i < users.length - 1) await sleep(c.delayBetweenActions);
        }
        
        if (c.autoCloseAfterClear) await closeMessenger();
        return true;
    }

    async function processNewMessage() {
        if (!isMessengerOpen()) {
            if (!(await openMessenger())) return false;
            await sleep(400);
        } else {
            await sleep(80);
        }
        
        var users = getAllUsers();
        if (users.length === 0) return false;

        var c = cfg();
        var userWithNewMessage = null;
        
        // Busca: badge > ativo > primeiro
        for (var i = 0; i < users.length; i++) {
            if (users[i].hasBadge) {
                userWithNewMessage = users[i];
                break;
            }
        }
        if (!userWithNewMessage) {
            for (var j = 0; j < users.length; j++) {
                if (users[j].isActive) {
                    userWithNewMessage = users[j];
                    break;
                }
            }
        }
        if (!userWithNewMessage && users.length > 0) {
            userWithNewMessage = users[0];
        }
        if (!userWithNewMessage) return false;

        if (await selectUser(userWithNewMessage)) {
            await sleep(c.delayAfterSelect);
            
            var n = (typeof window !== 'undefined' ? (window.__CONSOLE_TRACKER_N__ | 0) : 0);
            var text = (n % 2 === 0) ? c.message : (c.prefix + c.message);
            if (typeof window !== 'undefined') window.__CONSOLE_TRACKER_N__ = n + 1;
            
            await sendMessage(text);
            await sleep(100);
            await clearChat();
            await sleep(c.delayAfterClear);

            // Limpa chats restantes
            await sleep(150);
            var allUsers = getAllUsers();
            if (allUsers.length > 1) {
                var processedIndex = userWithNewMessage.index;
                for (var k = 0; k < allUsers.length; k++) {
                    if (allUsers[k].index === processedIndex) continue;
                    if (await selectUser(allUsers[k])) {
                        await sleep(c.delayAfterSelect);
                        await clearChat();
                        await sleep(c.delayAfterClear);
                    }
                    if (k < allUsers.length - 1) await sleep(c.delayBetweenActions);
                }
            }

            if (c.autoCloseAfterClear) await closeMessenger();
            return true;
        }
        return false;
    }

    async function mainLoop() {
        if (isProcessing || !enabled()) {
            if (!enabled()) {
                hasClearedOnStart = false;
                processedUsersSet.clear();
            }
            return;
        }
        
        isProcessing = true;
        try {
            var c = cfg();
            
            // Limpeza inicial apenas uma vez
            if (c.clearAllOnStart && !hasClearedOnStart) {
                await clearAllChats();
                hasClearedOnStart = true;
                return;
            }

            // SEMPRE verifica se existe o botão (com is-unseen ou false)
            var btn = document.querySelector(MESSAGE_BUTTON);
            if (!btn) {
                processedUsersSet.clear();
                return;
            }

            // Verifica se tem nova mensagem (is-unseen) ou se o botão existe (false também indica que existe)
            var hasNew = btn.classList.contains('is-unseen');
            var hasFalse = btn.classList.contains('false');
            
            // Se não tem nenhum dos dois estados, não há botão válido
            if (!hasNew && !hasFalse) {
                processedUsersSet.clear();
                return;
            }

            var now = Date.now();
            
            // Processa quando há nova mensagem (is-unseen) OU quando o botão existe (false)
            if (hasNew || hasFalse) {
                // Throttling mínimo para evitar processamento duplicado
                if (now - lastProcessedTime > 1500) {
                    lastProcessedTime = now;
                    if (hasNew) {
                        // Se há nova mensagem, processa normalmente
                        await processNewMessage();
                    } else if (hasFalse) {
                        // Se não há nova mensagem mas o botão existe (false), também processa
                        await processNewMessage();
                    }
                    processedUsersSet.clear();
                }
            } else {
                // Se não há nenhum dos dois estados, limpa todos periodicamente (se configurado)
                if (!c.respondOnlyToNewMessages && now - lastProcessedTime > 10000) {
                    lastProcessedTime = now;
                    await clearAllChats();
                }
            }

        } catch (err) {
            var errNow = Date.now();
            consecutiveErrors++;
            if (errNow - lastErrorTime > 5000 || consecutiveErrors > 5) {
                log('ERRO: ' + (err.message || String(err)) + ' (erros consecutivos: ' + consecutiveErrors + ')');
                lastErrorTime = errNow;
                // Reset após muitos erros
                if (consecutiveErrors > 10) {
                    hasClearedOnStart = false;
                    processedUsersSet.clear();
                    lastProcessedTime = 0;
                    consecutiveErrors = 0;
                    log('Reset automático após muitos erros');
                }
            }
        } finally {
            isProcessing = false;
            // Reset contador de erros após sucesso
            if (consecutiveErrors > 0) {
                consecutiveErrors = 0;
            }
        }
    }

    log('Console Tracker: Iniciado');
    
    // Observa mudanças na configuração em tempo real
    if (typeof window !== 'undefined') {
        var lastConfigHash = '';
        var configWatcher = setInterval(function () {
            if (!enabled()) {
                if (window.__CONSOLE_TRACKER_CONFIG_WATCHER__) {
                    clearInterval(window.__CONSOLE_TRACKER_CONFIG_WATCHER__);
                    window.__CONSOLE_TRACKER_CONFIG_WATCHER__ = null;
                }
                return;
            }
            try {
                var currentCfg = cfg();
                var currentHash = JSON.stringify(currentCfg);
                if (currentHash !== lastConfigHash) {
                    lastConfigHash = currentHash;
                    hasClearedOnStart = false;
                    processedUsersSet.clear();
                    lastProcessedTime = 0;
                }
            } catch (e) {}
        }, 300);
        
        if (window.__CONSOLE_TRACKER_CONFIG_WATCHER__) {
            clearInterval(window.__CONSOLE_TRACKER_CONFIG_WATCHER__);
        }
        window.__CONSOLE_TRACKER_CONFIG_WATCHER__ = configWatcher;
    }
    
    // Executa imediatamente e depois a cada 800ms
    mainLoop();
    var id = setInterval(function () {
        if (!enabled()) {
            clearInterval(id);
            if (typeof window !== 'undefined') {
                window.__CONSOLE_TRACKER_INTERVAL__ = null;
                window.__CONSOLE_TRACKER_LOADED__ = false;
                if (window.__CONSOLE_TRACKER_CONFIG_WATCHER__) {
                    clearInterval(window.__CONSOLE_TRACKER_CONFIG_WATCHER__);
                    window.__CONSOLE_TRACKER_CONFIG_WATCHER__ = null;
                }
            }
            hasClearedOnStart = false;
            processedUsersSet.clear();
            lastProcessedTime = 0;
            consecutiveErrors = 0;
            return;
        }
        mainLoop();
    }, 800);
    
    if (typeof window !== 'undefined') {
        window.__CONSOLE_TRACKER_INTERVAL__ = id;
    }
    
    // Watchdog: verifica se o intervalo ainda está rodando
    if (typeof window !== 'undefined') {
        var watchdogId = setInterval(function () {
            if (!enabled()) {
                clearInterval(watchdogId);
                return;
            }
            // Se o intervalo foi limpo mas o addon está habilitado, reinicia
            if (!window.__CONSOLE_TRACKER_INTERVAL__ && enabled()) {
                log('Watchdog: reiniciando intervalo');
                var newId = setInterval(function () {
                    if (!enabled()) {
                        clearInterval(newId);
                        if (typeof window !== 'undefined') {
                            window.__CONSOLE_TRACKER_INTERVAL__ = null;
                        }
                        return;
                    }
                    mainLoop();
                }, 800);
                window.__CONSOLE_TRACKER_INTERVAL__ = newId;
            }
        }, 3000);
        
        if (!window.__CONSOLE_TRACKER_WATCHDOG__) {
            window.__CONSOLE_TRACKER_WATCHDOG__ = watchdogId;
        }
    }
})();
