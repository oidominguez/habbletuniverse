import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import AddonsOverlay from './pages/AddonsOverlay';
import ProtocolPanel from './components/ProtocolPanel';
import GamePanel from './components/GamePanel';
import { pasteSession } from './components/pasteSession';
import CrowdPanel from './components/CrowdPanel';
import { Button, Input } from './components/ui';
import { useCrowdController } from './crowd/useCrowdController';
import { BoardColumn } from './components/Board';
import { useProtocolCapture } from './protocol/useProtocolCapture';
import { GameState } from './protocol/state/GameState';
import { useGameState } from './protocol/state/useGameState';
import { createGameActions } from './protocol/actions';
import { ADDONS, ADDON_BY_ID } from './addons/registry';
import { engineOf } from './addons/types';
import { useAddonStore } from './addons/useAddonStore';
import { useAllProtocolEngines } from './addons/protocol/useAllProtocolEngines';
import { buildClearLogsJs, buildPollJs, domActivateJs, domApplyConfigJs, domDeactivateJs, domLogPrefix, injectAllDom, useDomScripts } from './addons/dom/domScripts';
import { KNOWN_HEADERS } from '../shared/known-headers';
import { BUILD_LABEL, BUILD_MODE } from '../shared/build-info';
import type { AddonId, PersistedSettings, SettingsPatch } from '../shared/addon-config';

interface LogEntry {
  t: number;
  msg: string;
}

interface Stats {
  queue: number;
  processing: number;
  done: number;
  ignored?: number;
  notAcceptingRequests?: number;
  queueNames?: string[];
  processingNames?: string[];
  doneNames?: string[];
  ignoredNames?: string[];
  notAcceptingRequestsNames?: string[];
}

const defaultStats: Stats = { queue: 0, processing: 0, done: 0, ignored: 0, notAcceptingRequests: 0, queueNames: [], processingNames: [], doneNames: [], ignoredNames: [], notAcceptingRequestsNames: [] };

const URL_SHORTCUTS = [
  { label: 'Habblet', url: 'https://habblet.city' },
  { label: 'Jogar', url: 'https://habblet.city/hotel' },
];

type PanelTab = 'logs' | 'board' | 'protocol' | 'game' | 'crowd';
type WebviewEl = HTMLElement & {
  executeJavaScript: (c: string) => Promise<unknown>;
  getURL: () => string;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  send?: (channel: string, ...args: unknown[]) => void;
  src?: string;
};

export default function App() {
  /* ------------------------------------ refs / UI ------------------------------------ */
  const webviewRef = useRef<WebviewEl | null>(null);
  // Elemento como estado: efeitos que registram listeners rodam exatamente quando o <webview> monta.
  const [webviewEl, setWebviewEl] = useState<WebviewEl | null>(null);
  const webviewCallbackRef = useCallback((el: HTMLElement | null) => {
    webviewRef.current = el as WebviewEl | null;
    setWebviewEl(el as WebviewEl | null);
  }, []);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPollRef = useRef({ queue: -1, processing: -1, done: -1, ignored: 0, notAcceptingRequests: 0, logsLen: -1, lastLogKey: '' });
  const panelResizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const protoLogsRef = useRef<LogEntry[]>([]);

  const [urlInput, setUrlInput] = useState('');
  const [webviewSrc, setWebviewSrc] = useState('');
  const [webviewPreload, setWebviewPreload] = useState<string | null>(null);
  const [webviewLoading, setWebviewLoading] = useState(false);
  const [addonsPageOpen, setAddonsPageOpen] = useState(false);
  const [addonSettingsOpen, setAddonSettingsOpen] = useState<AddonId | null>(null);
  const [domStats, setDomStats] = useState<Stats>(defaultStats);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [toast, setToast] = useState({ show: false, message: '' });
  const [panelTab, setPanelTab] = useState<PanelTab>('logs');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [panelHeight, setPanelHeight] = useState(260);
  const [boardFilter, setBoardFilter] = useState('');
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  const [protocolLabels, setProtocolLabels] = useState<Record<string, string>>({});
  // Fora do Electron (Vite no navegador) não há nada a carregar: já começa "carregado".
  const [settingsLoaded, setSettingsLoaded] = useState(() => !window.habblet);

  const showToast = useCallback((msg: string) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToast({ show: true, message: msg });
    toastTimeoutRef.current = setTimeout(() => {
      setToast({ show: false, message: '' });
      toastTimeoutRef.current = null;
    }, 2500);
  }, []);

  /* ------------------------------ Persistência (electron-store via preload) ------------------------------ */
  const persistSettings = useCallback((patch: SettingsPatch) => {
    window.habblet?.settings.update(patch).catch(() => {});
  }, []);

  const store = useAddonStore(persistSettings);
  const domScripts = useDomScripts();

  const applyUi = useCallback((s: PersistedSettings) => {
    setPanelHeight(Math.max(160, s.ui.panelHeight));
    setPanelCollapsed(s.ui.panelCollapsed);
    setPanelTab(s.ui.panelTab);
  }, []);

  /** Empurra as configs para os scripts DOM já injetados (mesmo efeito de "Salvar" em cada addon). */
  const pushConfigsToWebview = useCallback((s: PersistedSettings) => {
    const w = webviewRef.current;
    if (!w?.executeJavaScript) return;
    const js = ADDONS.filter((d) => d.dom).map((d) => domApplyConfigJs(d, s.addons[d.id])).join('');
    if (js) w.executeJavaScript(js).catch(() => {});
  }, []);

  const hydrate = store.hydrate;
  useEffect(() => {
    const api = window.habblet;
    if (!api) return;
    let cancelled = false;
    api.getWebviewPreloadPath().then((p) => { if (!cancelled) setWebviewPreload(p); }).catch(() => {});
    api.settings.get().then((s) => {
      if (cancelled) return;
      hydrate(s, true);
      applyUi(s);
      setProtocolLabels(s.protocol.headerLabels);
      if (s.lastUrl) { setUrlInput(s.lastUrl); setWebviewSrc(s.lastUrl); }
    }).catch(() => {}).finally(() => { if (!cancelled) setSettingsLoaded(true); });
    return () => { cancelled = true; };
  }, [hydrate, applyUi]);

  useEffect(() => {
    if (!settingsLoaded) return;
    persistSettings({ lastUrl: webviewSrc });
  }, [webviewSrc, settingsLoaded, persistSettings]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const t = setTimeout(() => persistSettings({ ui: { panelHeight, panelCollapsed, sidebarCollapsed: false, panelTab } }), 300);
    return () => clearTimeout(t);
  }, [panelHeight, panelCollapsed, panelTab, settingsLoaded, persistSettings]);

  const exportProfile = useCallback(async () => {
    const api = window.habblet;
    if (!api) { showToast('Disponível apenas no aplicativo desktop'); return; }
    const r = await api.settings.exportProfile();
    if (r.ok) showToast('Perfil exportado');
    else if (!r.cancelled) showToast('Erro ao exportar: ' + r.error);
  }, [showToast]);

  const importProfile = useCallback(async () => {
    const api = window.habblet;
    if (!api) { showToast('Disponível apenas no aplicativo desktop'); return; }
    const r = await api.settings.importProfile();
    if (r.ok) {
      hydrate(r.settings, false);
      applyUi(r.settings);
      setProtocolLabels(r.settings.protocol.headerLabels);
      pushConfigsToWebview(r.settings);
      showToast('Perfil importado e aplicado');
    } else if (!r.cancelled) {
      showToast('Erro ao importar: ' + r.error);
    }
  }, [showToast, hydrate, applyUi, pushConfigsToWebview]);

  /* ------------------------------ Protocolo (sniffer do WebSocket do jogo) ------------------------------ */
  const gameState = useMemo(() => new GameState(), []);
  const onPacket = useCallback((p: Parameters<GameState['handle']>[0]) => gameState.handle(p), [gameState]);
  const protocol = useProtocolCapture(webviewEl, webviewSrc, onPacket);
  const game = useGameState(gameState);
  const gameActions = useMemo(() => createGameActions(protocol.sendPacket, gameState), [protocol.sendPacket, gameState]);

  const setProtocolLabel = useCallback((key: string, label: string) => {
    setProtocolLabels((prev) => {
      const next = { ...prev };
      if (label) next[key] = label;
      else delete next[key];
      persistSettings({ protocol: { headerLabels: next } });
      return next;
    });
  }, [persistSettings]);

  /* ------------------------------ Motores por protocolo ------------------------------ */
  const protoLog = useCallback((msg: string) => {
    protoLogsRef.current.push({ t: Date.now(), msg });
    if (protoLogsRef.current.length > 500) protoLogsRef.current.splice(0, protoLogsRef.current.length - 500);
    // Cópia em disco (<userData>/logs/app-<dia>.log) para diagnóstico fora da janela.
    window.habblet?.log?.append('painel', msg);
  }, []);
  const protoAddallStats = useAllProtocolEngines({
    configs: store.configs,
    enabled: store.enabled,
    state: gameState,
    snapshot: game,
    actions: gameActions,
    agentReady: protocol.agentReady,
    log: protoLog,
  });
  const addUserAllEngine = engineOf(ADDON_BY_ID.adduserall, store.configs.adduserall);
  const stats: Stats = addUserAllEngine === 'protocol' ? protoAddallStats : domStats;

  /* ------------------------------ Multidão ------------------------------ */
  const crowdCtl = useCrowdController({
    log: protoLog,
    configs: store.configs,
    webviewPreload,
    panelVisible: panelTab === 'crowd' && !panelCollapsed,
    layoutKey: `${panelHeight}|${panelCollapsed}|${panelTab}`,
    showToast,
  });

  // Sessão do "Colar quarto": vive fora do React para sobreviver ao fechar do cartão e à troca de aba.
  useEffect(() => {
    pasteSession.bind({ state: gameState, actions: gameActions, catalog: crowdCtl.furniCatalog, walls: crowdCtl.wallCatalog, log: protoLog });
  }, [gameState, gameActions, crowdCtl.furniCatalog, crowdCtl.wallCatalog, protoLog]);
  // Callback local para o atributo ref: passar `crowdCtl.attachHost` direto faz o linter do React tratar o objeto inteiro como ref.
  const { attachHost: crowdAttachHost } = crowdCtl;
  const crowdHostRef = useCallback((el: HTMLDivElement | null) => crowdAttachHost(el), [crowdAttachHost]);

  /* ------------------------------ Scripts DOM no webview ------------------------------ */
  const injectEnabledAddons = useCallback(() => {
    const w = webviewRef.current;
    if (!w?.executeJavaScript) return;
    injectAllDom(w, store.configs, store.enabled, domScripts);
  }, [store.configs, store.enabled, domScripts]);

  const onToggleAddon = useCallback((id: AddonId, enabled: boolean) => {
    const def = ADDON_BY_ID[id];
    const cfg = store.configs[id];
    store.setEnabled(id, enabled);
    const w = webviewRef.current;
    const engine = engineOf(def, cfg);
    const state = enabled ? 'ativado' : 'desativado';

    if (!def.dom) { showToast(`${def.name} ${state}`); return; }
    if (!w?.executeJavaScript) { if (enabled) showToast('Aguarde o navegador carregar'); return; }
    if (enabled && !webviewSrc) { showToast('Informe a URL e carregue a página'); return; }

    if (engine === 'protocol') {
      w.executeJavaScript(domDeactivateJs(def)).catch(() => {});
      showToast(`${def.name} ${state}`);
      return;
    }
    const script = domScripts[id];
    if (enabled) {
      if (!script) return;
      w.executeJavaScript(domActivateJs(def, cfg, script)).then(() => showToast(`${def.name} ativado (DOM)`)).catch(() => showToast('Erro ao injetar. Abra a página primeiro.'));
    } else {
      w.executeJavaScript(domDeactivateJs(def)).catch(() => {});
      showToast(`${def.name} desativado`);
    }
  }, [store, domScripts, webviewSrc, showToast]);

  const onSaveAddon = useCallback((id: AddonId) => {
    const def = ADDON_BY_ID[id];
    store.save(id);
    const w = webviewRef.current;
    if (def.dom && w?.executeJavaScript) w.executeJavaScript(domApplyConfigJs(def, store.configs[id])).catch(() => {});
    showToast(`${def.name}: configurações aplicadas`);
  }, [store, showToast]);

  const onRevertAddon = useCallback((id: AddonId) => {
    store.revert(id);
    showToast('Alterações descartadas');
  }, [store, showToast]);

  const snapshotLastSaved = store.snapshotLastSaved;
  useEffect(() => {
    if (addonSettingsOpen) snapshotLastSaved(addonSettingsOpen);
  }, [addonSettingsOpen, snapshotLastSaved]);

  // Polling de stats/logs dos scripts DOM
  useEffect(() => {
    if (!webviewSrc || !webviewRef.current) return;
    const intervalMs = store.enabled.adduserall ? 400 : 1200;
    const pollJs = buildPollJs();
    const id = setInterval(() => {
      const w = webviewRef.current;
      if (!w?.executeJavaScript) return;
      w.executeJavaScript(pollJs)
        .then((raw) => {
          const data = raw as { stats: Stats | null; logs: { id: AddonId; list: LogEntry[] }[] } | null;
          if (!data) return;
          const r = lastPollRef.current;
          const s = data.stats ? { ...defaultStats, ...data.stats } : null;
          const statsChanged = s && (s.queue !== r.queue || s.processing !== r.processing || s.done !== r.done || (s.ignored ?? 0) !== r.ignored || (s.notAcceptingRequests ?? 0) !== r.notAcceptingRequests);
          if (statsChanged && s) {
            lastPollRef.current = { ...r, queue: s.queue, processing: s.processing, done: s.done, ignored: s.ignored ?? 0, notAcceptingRequests: s.notAcceptingRequests ?? 0 };
            setDomStats(s);
          }
          const domLogs: LogEntry[] = [];
          for (const src of data.logs ?? []) {
            const prefix = domLogPrefix(src.id);
            for (const l of src.list ?? []) domLogs.push(prefix ? { ...l, msg: prefix + l.msg } : l);
          }
          const combined = [...domLogs, ...protoLogsRef.current].sort((a, b) => a.t - b.t).slice(-800);
          const lastLog = combined[combined.length - 1];
          const logKey = lastLog ? `${lastLog.t}-${lastLog.msg}` : '';
          if (combined.length !== r.logsLen || logKey !== r.lastLogKey) {
            lastPollRef.current = { ...lastPollRef.current, logsLen: combined.length, lastLogKey: logKey };
            setLogs(combined);
          }
        })
        .catch(() => {});
    }, intervalMs);
    return () => clearInterval(id);
  }, [webviewSrc, store.enabled.adduserall]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  /* ------------------------------ Webview: popups, navegação, loading ------------------------------ */
  useEffect(() => {
    if (!window.habblet?.onWebviewOpenUrl) return;
    return window.habblet.onWebviewOpenUrl((url) => {
      setUrlInput(url);
      setWebviewSrc(url);
    });
  }, []);

  useEffect(() => {
    if (!webviewSrc) return;
    const w = webviewEl;
    if (!w?.addEventListener) return;

    const onNavigate = () => showToast('Página alterada. Addons serão reaplicados ao carregar.');
    const onFailLoad = (e: Event) => {
      const ev = e as Event & { errorCode?: number; isMainFrame?: boolean };
      if (ev.isMainFrame !== true) return;
      setWebviewLoading(false);
      if (ev.errorCode === -3) return;
      showToast(ev.errorCode === -105
        ? 'Não foi possível carregar: domínio não encontrado. Confira a URL e a conexão.'
        : 'Não foi possível carregar a página. Verifique a URL e a conexão.');
    };
    const onStartLoading = () => setWebviewLoading(true);
    const onStopLoading = (e: Event) => {
      if ((e as Event & { isMainFrame?: boolean }).isMainFrame !== false) {
        setWebviewLoading(false);
        injectEnabledAddons();
      }
    };

    w.addEventListener('did-navigate', onNavigate);
    w.addEventListener('did-fail-load', onFailLoad);
    w.addEventListener('did-start-loading', onStartLoading);
    w.addEventListener('did-stop-loading', onStopLoading);
    return () => {
      w.removeEventListener('did-navigate', onNavigate);
      w.removeEventListener('did-fail-load', onFailLoad);
      w.removeEventListener('did-start-loading', onStartLoading);
      w.removeEventListener('did-stop-loading', onStopLoading);
    };
  }, [webviewSrc, webviewEl, showToast, injectEnabledAddons]);

  // Arrastar para redimensionar o painel inferior
  useEffect(() => {
    if (!isResizingPanel) return;
    const onMove = (e: MouseEvent) => {
      const r = panelResizeRef.current;
      if (!r) return;
      const d = r.startY - e.clientY;
      setPanelHeight(() => Math.min(Math.round(window.innerHeight * 0.8), Math.max(160, r.startH + d)));
    };
    const onUp = () => {
      panelResizeRef.current = null;
      setIsResizingPanel(false);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingPanel]);

  const go = useCallback(() => {
    const u = urlInput.trim();
    if (!u) { showToast('Digite a URL'); return; }
    setWebviewSrc(u.startsWith('http') ? u : `https://${u}`);
  }, [urlInput, showToast]);

  // Atalhos: Ctrl+K foca a URL; Ctrl+J alterna o painel inferior; Ctrl+, abre os addons.
  // Chegam pelo documento do app ou, com o foco no jogo, pelo processo principal (before-input-event).
  const runShortcut = useCallback((key: string) => {
    if (key === 'k') (document.querySelector('[data-url-input]') as HTMLInputElement | null)?.focus();
    else if (key === 'j') setPanelCollapsed((c) => !c);
    else if (key === ',') { setAddonsPageOpen((o) => !o); setAddonSettingsOpen(null); }
    else if (key.startsWith('tab:')) {
      // instância de teste (HABBLET_OPEN=tab:<aba>): abre o dock numa aba
      const tab = key.slice('tab:'.length) as PanelTab;
      if (['logs', 'board', 'protocol', 'game', 'crowd'].includes(tab)) { setPanelTab(tab); setPanelCollapsed(false); if (tab === 'crowd' || tab === 'game') setPanelHeight((h) => Math.max(h, 460)); }
    } else if (key.startsWith('open:')) {
      // usado pela instância de teste (HABBLET_OPEN) para abrir a gaveta / uma tela de settings
      const id = key.slice('open:'.length) as AddonId | '';
      setAddonsPageOpen(true);
      setAddonSettingsOpen(id && id in ADDON_BY_ID ? id : null);
    }
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && t.dataset?.urlInput) { go(); e.preventDefault(); return; }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'k' || key === 'j' || key === ',') { e.preventDefault(); runShortcut(key); }
    };
    document.addEventListener('keydown', onKey);
    const unsub = window.habblet?.onShortcut?.(runShortcut);
    return () => { document.removeEventListener('keydown', onKey); unsub?.(); };
  }, [go, runShortcut]);

  const nav = (fn: 'goBack' | 'goForward' | 'reload') => {
    const w = webviewRef.current;
    if (w?.[fn]) w[fn]();
  };

  /* ------------------------------ Logs / Board ------------------------------ */
  const clearLogs = async () => {
    const w = webviewRef.current;
    protoLogsRef.current = [];
    if (w?.executeJavaScript) {
      try { await w.executeJavaScript(buildClearLogsJs()); } catch { /* ignore */ }
    }
    setLogs([]);
    showToast('Logs limpos');
  };

  const download = (name: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportLogs = () => {
    download(`addall-logs-${Date.now()}.txt`, logs.map((l) => `[${new Date(l.t).toLocaleTimeString('pt-BR')}] ${l.msg}`).join('\n') || '(vazio)');
    showToast('Logs exportados');
  };

  const filtered = useMemo(() => {
    const f = boardFilter.toLowerCase();
    const pick = (names?: string[]) => (names || []).filter((n) => !f || n.toLowerCase().includes(f));
    return {
      q: pick(stats.queueNames), pr: pick(stats.processingNames), dn: pick(stats.doneNames), ig: pick(stats.ignoredNames), nar: pick(stats.notAcceptingRequestsNames),
    };
  }, [stats.queueNames, stats.processingNames, stats.doneNames, stats.ignoredNames, stats.notAcceptingRequestsNames, boardFilter]);

  const exportBoard = () => {
    const lines = [
      '=== FILA ===', ...(stats.queueNames || []), '',
      '=== PROCESSANDO ===', ...(stats.processingNames || []), '',
      '=== CONCLUÍDOS ===', ...(stats.doneNames || []), '',
      '=== IGNORADOS ===', ...(stats.ignoredNames || []), '',
      '=== NÃO ACEITA SOLICITAÇÕES ===', ...(stats.notAcceptingRequestsNames || []),
    ];
    download(`addall-board-${Date.now()}.txt`, lines.join('\n'));
    showToast('Board exportado');
  };

  /* ------------------------------ derivados de UI ------------------------------ */
  const openAddons = () => { setAddonsPageOpen(true); setAddonSettingsOpen(null); };
  const selectTab = (t: PanelTab) => {
    if (panelTab === t && !panelCollapsed) setPanelCollapsed(true);
    else {
      setPanelTab(t);
      setPanelCollapsed(false);
      // Abas densas (Multidão, Jogo) precisam de mais altura para não virar rolagem dentro de rolagem.
      if ((t === 'crowd' || t === 'game') && panelHeight < 420) setPanelHeight(Math.min(Math.round(window.innerHeight * 0.6), 460));
    }
  };
  const roomUserCount = game.room.users.filter((u) => u.type === 1).length;
  const roomLabel = game.room.id === null ? 'fora de quarto' : cleanRoomName(game.room.name) || `#${game.room.id}`;
  const activeAddons = ADDONS.filter((d) => store.enabled[d.id]);
  const addallOn = store.enabled.adduserall;

  /* ------------------------------------ render ------------------------------------ */
  return (
    <div className="flex h-full bg-bg text-fg">
      {/* Trilho esquerdo: marca + navegação do dock + addons */}
      <nav className="flex w-14 shrink-0 flex-col items-center border-r border-line bg-surface py-3">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-bg" title={`Habblet AddAll · build ${BUILD_MODE} ${BUILD_LABEL}`}>
          <div className="brand-pixel" />
        </div>
        <RailButton label="Jogo" active={panelTab === 'game' && !panelCollapsed} onClick={() => selectTab('game')} badge={game.pendingRequests.length || undefined} badgeTone="warn">
          <IconUsers />
        </RailButton>
        <RailButton label="Logs" active={panelTab === 'logs' && !panelCollapsed} onClick={() => selectTab('logs')}>
          <IconList />
        </RailButton>
        <RailButton label="Board da fila" active={panelTab === 'board' && !panelCollapsed} onClick={() => selectTab('board')}>
          <IconColumns />
        </RailButton>
        <RailButton label="Protocolo" active={panelTab === 'protocol' && !panelCollapsed} onClick={() => selectTab('protocol')} dot={protocol.agentReady}>
          <IconPulse />
        </RailButton>
        <RailButton label="Multidão" active={panelTab === 'crowd' && !panelCollapsed} onClick={() => selectTab('crowd')} badge={crowdCtl.snap.sessions.filter((s) => s.status === 'online').length || undefined} badgeTone="accent">
          <IconCrowd />
        </RailButton>
        <div className="my-3 h-px w-6 bg-line" />
        <RailButton label="Addons (Ctrl+,)" active={addonsPageOpen} onClick={openAddons} badge={activeAddons.length || undefined} badgeTone="accent">
          <IconPuzzle />
        </RailButton>
        <div className="mt-auto flex flex-col items-center gap-1.5 pb-1">
          <div className="flex flex-col items-center gap-1.5" title={protocol.agentReady ? 'Agente ativo: interceptando o jogo' : 'Agente inativo'}>
            <span className={`h-2 w-2 rounded-full ${protocol.agentReady ? 'bg-accent animate-pulse-dot' : 'bg-line-strong'}`} />
            <span className="text-[9px] uppercase tracking-wider text-dim">{protocol.agentReady ? 'live' : 'off'}</span>
          </div>
          {/* Marca do build: confere com o título da janela. Serve para não rodar um executável velho sem perceber. */}
          <span className="tnum mt-1 text-[9px] text-dim" title={`Build ${BUILD_MODE === 'dev' ? 'de desenvolvimento' : 'empacotado'} de ${BUILD_LABEL}. O título da janela mostra o mesmo.`}>
            {BUILD_MODE === 'dev' ? 'dev' : BUILD_LABEL.split(' ')[1]}
          </span>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barra superior: URL + navegação + status */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          <div className="flex items-center gap-0.5">
            <IconButton title="Voltar" onClick={() => nav('goBack')}><IconArrow dir="left" /></IconButton>
            <IconButton title="Avançar" onClick={() => nav('goForward')}><IconArrow dir="right" /></IconButton>
            <IconButton title="Recarregar" onClick={() => nav('reload')}><IconReload spinning={webviewLoading && !!webviewSrc} /></IconButton>
          </div>
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-bg pl-3 pr-1 focus-within:border-accent/60">
            <IconGlobe />
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && go()}
              placeholder="URL do cliente (Ctrl+K)"
              data-url-input={true}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder-dim"
            />
            <div className="hidden items-center gap-1 md:flex">
              {URL_SHORTCUTS.map((s) => (
                <button key={s.url} onClick={() => { setUrlInput(s.url); setWebviewSrc(s.url); }} className="rounded-md px-2 py-0.5 text-[11px] text-muted hover:bg-raised hover:text-fg" title={s.url}>{s.label}</button>
              ))}
            </div>
            <button onClick={go} className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-ink hover:bg-accent-strong">Ir</button>
          </div>

          {/* Status: eu · sala · pedidos */}
          <div className="ml-1 hidden items-center gap-1.5 lg:flex">
            <Pill title="Sua conta (pacote 2725)">
              <span className={`h-1.5 w-1.5 rounded-full ${game.me ? 'bg-accent' : 'bg-line-strong'}`} />
              {game.me ? game.me.name : 'sem login'}
            </Pill>
            <Pill title={game.room.name ?? 'fora de quarto'}>
              <IconDoor />
              <span className="max-w-[200px] truncate">{roomLabel}</span>
              {game.room.id !== null && <span className="tnum text-dim">{roomUserCount}</span>}
            </Pill>
            {game.pendingRequests.length > 0 && (
              <button onClick={() => selectTab('game')} className="flex h-7 items-center gap-1.5 rounded-md bg-warn/15 px-2 text-[11px] font-medium text-warn hover:bg-warn/25" title="Pedidos de amizade pendentes">
                ★ {game.pendingRequests.length}
              </button>
            )}
          </div>
        </header>

        {/* Centro: jogo */}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
          {!webviewSrc ? (
            <EmptyState onShortcut={(u) => { setUrlInput(u); setWebviewSrc(u); }} onAddons={openAddons} />
          ) : (
            <>
              {(!window.habblet || webviewPreload) && (
                <webview
                  ref={webviewCallbackRef as never}
                  src={webviewSrc}
                  partition="persist:habblet"
                  allowpopups={true}
                  preload={webviewPreload ?? undefined}
                  webpreferences="sandbox=no"
                  style={{ flex: 1, minHeight: 0 }}
                />
              )}
              {webviewLoading && <div className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-accent" />}
            </>
          )}

          {/* Chips do Add User All flutuando sobre o jogo, só quando ativo */}
          {addallOn && (
            <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 animate-fade-up">
              <Chip tone="warn" label="fila" value={stats.queue} />
              <Chip tone="accent" label="enviados" value={stats.done} />
              {(stats.ignored ?? 0) > 0 && <Chip tone="muted" label="ignorados" value={stats.ignored ?? 0} />}
              {(stats.notAcceptingRequests ?? 0) > 0 && <Chip tone="muted" label="não aceita" value={stats.notAcceptingRequests ?? 0} />}
            </div>
          )}
        </main>

        {/* Dock inferior */}
        <section className={`shrink-0 border-t border-line bg-surface ${panelCollapsed ? '' : 'shadow-dock'}`}>
          {!panelCollapsed && (
            <div
              role="separator"
              aria-label="Redimensionar painel"
              onMouseDown={(e) => { e.preventDefault(); panelResizeRef.current = { startY: e.clientY, startH: panelHeight }; setIsResizingPanel(true); }}
              className="group flex h-2 cursor-ns-resize items-center justify-center"
              title="Arrastar para redimensionar"
            >
              <span className="h-0.5 w-8 rounded-full bg-line group-hover:bg-accent" />
            </div>
          )}
          <div className="flex h-10 items-center gap-1 px-2">
            <div className="flex items-center gap-0.5 rounded-lg bg-bg p-0.5">
              <Tab active={panelTab === 'logs' && !panelCollapsed} onClick={() => selectTab('logs')}>Logs</Tab>
              <Tab active={panelTab === 'board' && !panelCollapsed} onClick={() => selectTab('board')}>Board</Tab>
              <Tab active={panelTab === 'game' && !panelCollapsed} onClick={() => selectTab('game')}>
                Jogo{roomUserCount > 0 && <span className="tnum ml-1.5 text-dim">{roomUserCount}</span>}
              </Tab>
              <Tab active={panelTab === 'protocol' && !panelCollapsed} onClick={() => selectTab('protocol')}>
                Protocolo{protocol.agentReady && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent" />}
              </Tab>
              <Tab active={panelTab === 'crowd' && !panelCollapsed} onClick={() => selectTab('crowd')}>
                Multidão{crowdCtl.snap.connectedIds.length > 0 && <span className="tnum ml-1.5 text-dim">{crowdCtl.snap.sessions.filter((s) => s.status === 'online').length}/{crowdCtl.snap.connectedIds.length}</span>}
              </Tab>
            </div>
            <div className="ml-auto flex items-center gap-1">
              {panelTab === 'logs' && !panelCollapsed && (
                <>
                  <TextButton onClick={clearLogs}>Limpar</TextButton>
                  <TextButton onClick={exportLogs}>Exportar</TextButton>
                </>
              )}
              {panelTab === 'board' && !panelCollapsed && (
                <>
                  <Input type="text" value={boardFilter} onChange={(e) => setBoardFilter(e.target.value)} placeholder="filtrar nomes" className="w-40" />
                  <TextButton onClick={exportBoard}>Exportar</TextButton>
                </>
              )}
              <IconButton title={panelCollapsed ? 'Expandir painel (Ctrl+J)' : 'Recolher painel (Ctrl+J)'} onClick={() => setPanelCollapsed(!panelCollapsed)}>
                <IconChevron up={panelCollapsed} />
              </IconButton>
            </div>
          </div>
          {!panelCollapsed && (
            <div className="flex overflow-hidden border-t border-line" style={{ height: panelHeight }}>
              {panelTab === 'logs' && (
                <div className="flex-1 overflow-y-auto font-mono text-[11px] text-fg-2">
                  {logs.length === 0 ? (
                    <EmptyHint>Nenhum log ainda. Ative um addon para ver a atividade.</EmptyHint>
                  ) : (
                    <div className="px-2 py-1">
                      {logs.map((l, i) => (
                        <div key={i} className="flex gap-3 rounded px-1 py-0.5 hover:bg-raised/60">
                          <span className="tnum shrink-0 text-dim">{new Date(l.t).toLocaleTimeString('pt-BR', { hour12: false })}</span>
                          <span className="min-w-0 break-words">{l.msg}</span>
                        </div>
                      ))}
                      <div ref={logsEndRef} />
                    </div>
                  )}
                </div>
              )}
              {panelTab === 'game' && <GamePanel game={game} actions={gameActions} agentReady={protocol.agentReady} furniCatalog={crowdCtl.furniCatalog} wallCatalog={crowdCtl.wallCatalog} state={gameState} showToast={showToast} />}
              {panelTab === 'crowd' && (
                <CrowdPanel {...crowdCtl.panelProps} showToast={showToast} />
              )}
              {panelTab === 'protocol' && (
                <ProtocolPanel capture={protocol} labels={{ ...KNOWN_HEADERS, ...protocolLabels }} onSetLabel={setProtocolLabel} showToast={showToast} />
              )}
              {panelTab === 'board' && (
                <div className="grid flex-1 grid-cols-5 gap-2 overflow-auto p-2">
                  <BoardColumn title="Fila" names={filtered.q} variant="warning" />
                  <BoardColumn title="Processando" names={filtered.pr} variant="blue" />
                  <BoardColumn title="Enviados" names={filtered.dn} variant="success" />
                  <BoardColumn title="Ignorados" names={filtered.ig} variant="muted" />
                  <BoardColumn title="Não aceita" names={filtered.nar} variant="muted" />
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Camada única das telas da Multidão: um host fixo posicionado sobre o espaço das telas.
          Os <webview> das contas vivem DENTRO dele, criados à mão (CrowdGuestHost); mostramos um
          por vez trocando só o CSS, sem nunca reparentar/recarregar o guest. */}
      <div
        ref={crowdHostRef}
        className={crowdCtl.guestsVisible ? 'fixed z-30 overflow-hidden bg-black' : 'fixed overflow-hidden'}
        style={crowdCtl.guestsVisible && crowdCtl.tilesRect
          ? { left: crowdCtl.tilesRect.x, top: crowdCtl.tilesRect.y, width: crowdCtl.tilesRect.w, height: crowdCtl.tilesRect.h }
          : { left: -20000, top: 0, width: 1280, height: 720, pointerEvents: 'none' }}
      />
      {crowdCtl.guestsVisible && crowdCtl.tilesRect && crowdCtl.selectedSession?.status === 'captcha' && (
        <div
          className="pointer-events-none fixed z-40 rounded-md bg-warn px-2 py-1 text-[11px] font-medium text-accent-ink shadow"
          style={{ left: crowdCtl.tilesRect.x + 8, top: crowdCtl.tilesRect.y + 8, maxWidth: crowdCtl.tilesRect.w - 16 }}
        >
          {crowdCtl.selectedSession.account.username} · {crowdCtl.selectedSession.detail}
        </div>
      )}

      {addonsPageOpen && (
        <AddonsOverlay
          store={store}
          addonSettingsOpen={addonSettingsOpen}
          onClose={() => { setAddonsPageOpen(false); setAddonSettingsOpen(null); }}
          onBack={() => setAddonSettingsOpen(null)}
          onOpenSettings={setAddonSettingsOpen}
          onToggle={onToggleAddon}
          onSave={onSaveAddon}
          onRevert={onRevertAddon}
          onExportProfile={exportProfile}
          onImportProfile={importProfile}
          showToast={showToast}
        />
      )}

      {/* Toast */}
      <div className={`pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-raised px-4 py-2 text-[13px] text-fg shadow-2xl transition-all duration-200 ${toast.show ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'}`}>
        {toast.message}
      </div>
    </div>
  );
}

/** Nomes de quarto do Habblet usam espaços "invisíveis" (U+3164, U+2000–200B) para alinhar; colapsa tudo em um espaço. */
function cleanRoomName(name: string | null): string {
  if (!name) return '';
  return name.replace(/[\u3164\u2000-\u200b\u00a0\s]+/g, ' ').trim();
}

/* ------------------------------------ peças de UI ------------------------------------ */

function RailButton({ label, active, onClick, children, badge, badgeTone, dot }: { label: string; active: boolean; onClick: () => void; children: ReactNode; badge?: number; badgeTone?: 'accent' | 'warn'; dot?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`relative mb-1 flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-raised hover:text-fg'}`}
    >
      {children}
      {badge !== undefined && (
        <span className={`tnum absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full px-1 text-[9px] font-semibold leading-4 ${badgeTone === 'warn' ? 'bg-warn text-accent-ink' : 'bg-accent text-accent-ink'}`}>{badge}</span>
      )}
      {dot && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent" />}
    </button>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg">
      {children}
    </button>
  );
}

function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <Button variant="ghost" onClick={onClick}>{children}</Button>;
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={`flex h-7 items-center rounded-md px-3 text-[12px] font-medium transition-colors ${active ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}>
      {children}
    </button>
  );
}

function Pill({ title, children }: { title?: string; children: ReactNode }) {
  return <span title={title} className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-[11px] text-fg-2">{children}</span>;
}

function Chip({ tone, label, value }: { tone: 'warn' | 'accent' | 'muted'; label: string; value: number }) {
  const tones = { warn: 'text-warn', accent: 'text-accent', muted: 'text-muted' };
  return (
    <span className="flex items-center gap-1.5 rounded-md border border-line bg-surface/90 px-2 py-1 text-[11px] backdrop-blur">
      <span className={`tnum font-semibold ${tones[tone]}`}>{value}</span>
      <span className="text-dim">{label}</span>
    </span>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-dim">{children}</div>;
}

function EmptyState({ onShortcut, onAddons }: { onShortcut: (url: string) => void; onAddons: () => void }) {
  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden">
      <div className="empty-grid absolute inset-0" />
      <div className="relative w-full max-w-md px-6 animate-fade-up">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface shadow-glow"><div className="brand-pixel" /></div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-fg">Habblet AddAll</h1>
            <p className="text-[13px] text-muted">O jogo por dentro: pacotes, não cliques.</p>
          </div>
        </div>
        <ol className="space-y-3 text-[13px] text-fg-2">
          <Step n={1}>Abra o hotel e faça login.
            <div className="mt-2 flex gap-2">
              {URL_SHORTCUTS.map((s) => (
                <button key={s.url} onClick={() => onShortcut(s.url)} className="rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] text-fg hover:border-accent/60 hover:text-accent">{s.label}</button>
              ))}
            </div>
          </Step>
          <Step n={2}>Entre num quarto. A aba <b className="font-medium text-fg">Jogo</b> lista quem está lá direto do servidor.</Step>
          <Step n={3}>Ative o que precisar em <button onClick={onAddons} className="font-medium text-accent hover:underline">Addons</button>. Tudo roda pelo protocolo.</Step>
        </ol>
        <p className="mt-6 text-[11px] text-dim">Atalhos: Ctrl+K URL · Ctrl+J painel · Ctrl+, addons</p>
        <p className="mt-1 text-[11px] text-dim">Build {BUILD_MODE === 'dev' ? 'de desenvolvimento' : 'empacotado'} de {BUILD_LABEL}</p>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="tnum mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-surface text-[11px] font-semibold text-accent">{n}</span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

/* ------------------------------------ ícones ------------------------------------ */
const ic = 'h-[18px] w-[18px]';
function IconUsers() { return <svg className={ic} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-5-3.9M9 20H4v-2a4 4 0 014-4h2a4 4 0 014 4v2H9zm3-11a3 3 0 100-6 3 3 0 000 6zm7 1a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" /></svg>; }
function IconList() { return <svg className={ic} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>; }
function IconColumns() { return <svg className={ic} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="10" rx="1" /><rect x="17" y="4" width="4" height="13" rx="1" /></svg>; }
function IconPulse() { return <svg className={ic} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4l2-6 4 12 2-6h6" /></svg>; }
function IconCrowd() { return <svg className={ic} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><circle cx="8" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.5 19a5.5 5.5 0 0111 0M13.5 18.5a4 4 0 018 0" /></svg>; }
function IconPuzzle() { return <svg className={ic} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M10 4a2 2 0 114 0v1h3a1 1 0 011 1v3h1a2 2 0 110 4h-1v3a1 1 0 01-1 1h-3v1a2 2 0 11-4 0v-1H7a1 1 0 01-1-1v-3H5a2 2 0 110-4h1V6a1 1 0 011-1h3V4z" /></svg>; }
function IconGlobe() { return <svg className="h-3.5 w-3.5 shrink-0 text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></svg>; }
function IconDoor() { return <svg className="h-3.5 w-3.5 shrink-0 text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M5 21V5a2 2 0 012-2h10a2 2 0 012 2v16M3 21h18M15 12h.01" /></svg>; }
function IconArrow({ dir }: { dir: 'left' | 'right' }) { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d={dir === 'left' ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'} /></svg>; }
function IconReload({ spinning }: { spinning: boolean }) { return <svg className={`h-4 w-4 ${spinning ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M5.6 15A7 7 0 0019 12M18.4 9A7 7 0 005 12" /></svg>; }
function IconChevron({ up }: { up: boolean }) { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d={up ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'} /></svg>; }
