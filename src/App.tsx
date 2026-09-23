import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import AddonsOverlay from './pages/AddonsOverlay';
import ProtocolPanel from './components/ProtocolPanel';
import GamePanel from './components/GamePanel';
import { pasteSession } from './components/pasteSession';
import CrowdPanel from './components/CrowdPanel';
import { Button, Input } from './components/ui';
import { Sky, LiveDot } from './components/Sky';
import { BrandMark, Wordmark } from './components/Brand';
import { Avatar } from './components/Avatar';
import Palette from './components/Palette';
import { logSource, LOG_SOURCES } from './components/logSource';
import type { LogSource } from './components/logSource';
import { cx } from './components/cx';
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
const PANEL_TABS: PanelTab[] = ['logs', 'board', 'game', 'protocol', 'crowd'];
type WebviewEl = HTMLElement & {
  executeJavaScript: (c: string) => Promise<unknown>;
  getURL: () => string;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  send?: (channel: string, ...args: unknown[]) => void;
  src?: string;
};

/** Margem entre o palco (borda arredondada do jogo) e as peças que flutuam sobre ele. */
const STAGE_INSET = 12;

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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [logFilter, setLogFilter] = useState<LogSource | 'all'>('all');
  const [logText, setLogText] = useState('');
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

  // Arrastar para redimensionar a folha do dock
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

  // Atalhos: Ctrl+K abre a paleta; Ctrl+J alterna o painel inferior; Ctrl+, abre os addons.
  // Chegam pelo documento do app ou, com o foco no jogo, pelo processo principal (before-input-event).
  const runShortcut = useCallback((key: string) => {
    if (key === 'k') setPaletteOpen((o) => !o);
    else if (key === 'j') setPanelCollapsed((c) => !c);
    else if (key === ',') { setAddonsPageOpen((o) => !o); setAddonSettingsOpen(null); }
    else if (key.startsWith('tab:')) {
      // instância de teste (HABBLET_OPEN=tab:<aba>): abre o dock numa aba
      const tab = key.slice('tab:'.length) as PanelTab;
      if (PANEL_TABS.includes(tab)) { setPanelTab(tab); setPanelCollapsed(false); if (tab === 'crowd' || tab === 'game') setPanelHeight((h) => Math.max(h, 460)); }
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

  const visibleLogs = useMemo(() => {
    const t = logText.trim().toLowerCase();
    return logs.filter((l) => (logFilter === 'all' || logSource(l.msg) === logFilter) && (!t || l.msg.toLowerCase().includes(t)));
  }, [logs, logFilter, logText]);
  const logCounts = useMemo(() => {
    const c: Record<LogSource, number> = { addons: 0, crowd: 0, paste: 0, system: 0 };
    for (const l of logs) c[logSource(l.msg)]++;
    return c;
  }, [logs]);

  const exportLogs = () => {
    download(`universe-logs-${Date.now()}.txt`, visibleLogs.map((l) => `[${new Date(l.t).toLocaleTimeString('pt-BR')}] ${l.msg}`).join('\n') || '(vazio)');
    showToast(visibleLogs.length === logs.length ? 'Logs exportados' : `${visibleLogs.length} linhas filtradas exportadas`);
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
    download(`universe-board-${Date.now()}.txt`, lines.join('\n'));
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
  const crowdOnline = crowdCtl.snap.sessions.filter((s) => s.status === 'online').length;
  const crowdConnected = crowdCtl.snap.connectedIds.length;
  const sheetOpen = !panelCollapsed && !!webviewSrc;
  const buildShort = BUILD_MODE === 'dev' ? 'dev' : BUILD_LABEL;

  /* ------------------------------------ render ------------------------------------ */
  return (
    <div className="relative flex h-full flex-col bg-bg text-fg">
      {/* Barra de título: marca · navegação em pílula · endereço */}
      <header className="relative z-20 flex h-14 shrink-0 items-center gap-4 px-5">
        <div className="flex w-[300px] shrink-0 items-center gap-3">
          <BrandMark size={26} />
          <Wordmark />
          <span className="tnum text-[10.5px] text-dim" title={`Build ${BUILD_MODE === 'dev' ? 'de desenvolvimento' : 'empacotado'} de ${BUILD_LABEL}. O título da janela mostra o mesmo.`}>{buildShort}</span>
        </div>

        <nav aria-label="Seções" className="flex min-w-0 flex-1 justify-center">
          <div className="flex items-center gap-0.5 rounded-full border border-line bg-fg/[0.045] p-[3px]">
            <NavItem active={!sheetOpen} onClick={() => setPanelCollapsed(true)} title="Só o jogo (Ctrl+J alterna o painel)">Jogo</NavItem>
            <NavItem active={sheetOpen && panelTab === 'crowd'} onClick={() => selectTab('crowd')} badge={crowdConnected > 0 ? `${crowdOnline}/${crowdConnected}` : undefined} badgeTone="accent">Multidão</NavItem>
            <NavItem active={sheetOpen && panelTab === 'game'} onClick={() => selectTab('game')} badge={game.pendingRequests.length || undefined} badgeTone="warn">Sala</NavItem>
            <NavItem active={sheetOpen && panelTab === 'protocol'} onClick={() => selectTab('protocol')} dot={protocol.agentReady}>Protocolo</NavItem>
            <NavItem active={sheetOpen && (panelTab === 'logs' || panelTab === 'board')} onClick={() => selectTab('logs')}>Logs</NavItem>
            <NavItem active={addonsPageOpen} onClick={openAddons} badge={activeAddons.length || undefined} badgeTone="accent" title="Addons (Ctrl+,)">Addons</NavItem>
          </div>
        </nav>

        <div className="flex w-[300px] shrink-0 items-center justify-end gap-1">
          <IconButton title="Voltar" onClick={() => nav('goBack')}><IconArrow dir="left" /></IconButton>
          <IconButton title="Avançar" onClick={() => nav('goForward')}><IconArrow dir="right" /></IconButton>
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border border-line bg-fg/[0.045] pl-3 pr-1 focus-within:border-accent/60">
            <IconGlobe />
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && go()}
              placeholder="endereço"
              data-url-input={true}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder-dim"
            />
            <button onClick={() => nav('reload')} className="flex h-6 w-6 items-center justify-center rounded-full text-dim hover:text-fg" title="Recarregar"><IconReload spinning={webviewLoading && !!webviewSrc} /></button>
            <button onClick={go} className="h-6 rounded-full bg-fg px-2.5 text-[11px] font-bold text-bg hover:bg-white">Ir</button>
          </div>
        </div>
      </header>

      {/* Palco: o jogo em tela cheia com cantos suaves; tudo o mais flutua sobre ele */}
      <main className="relative z-10 min-h-0 min-w-0 flex-1" style={{ padding: `0 ${STAGE_INSET}px ${STAGE_INSET}px` }}>
        <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[18px] border border-line bg-surface">
          <Sky stars={webviewSrc ? 90 : 140} seed={webviewSrc ? 7 : 3} />

          {!webviewSrc ? (
            <EmptyState urlInput={urlInput} onUrlChange={setUrlInput} onGo={go} onShortcut={(u) => { setUrlInput(u); setWebviewSrc(u); }} onAddons={openAddons} />
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
                  style={{ flex: 1, minHeight: 0, position: 'relative', zIndex: 1 }}
                />
              )}
              {webviewLoading && <div className="absolute inset-x-0 top-0 z-30 h-0.5 animate-pulse bg-accent" />}

              {/* Ilha: quem sou, onde estou, o que está pendente */}
              <div className="glass animate-rise pointer-events-auto absolute left-1/2 top-3.5 z-30 flex h-11 -translate-x-1/2 items-center gap-1.5 rounded-full pl-2 pr-2 shadow-float">
                <div className="flex h-[30px] items-center gap-2.5 pl-1 pr-3" title="Sua conta (pacote 2725)">
                  <Avatar name={game.me?.name ?? ''} figure={game.me?.figure} size={20} ringFast={!!game.me} dim={!game.me} />
                  <span className="text-[13px] font-semibold">{game.me ? game.me.name : 'sem login'}</span>
                  {game.me ? <LiveDot /> : <span className="h-1.5 w-1.5 rounded-full bg-line-strong" />}
                </div>
                <span className="h-[18px] w-px bg-line-strong" />
                <div className="flex h-[30px] items-center gap-2 px-3 text-muted" title={game.room.name ?? 'fora de quarto'}>
                  <IconDoor />
                  <span className="max-w-[220px] truncate text-[13px] text-fg">{roomLabel}</span>
                  {game.room.id !== null && <span className="tnum font-mono text-[12px] text-dim">{roomUserCount}</span>}
                </div>
                {game.pendingRequests.length > 0 && (
                  <>
                    <span className="h-[18px] w-px bg-line-strong" />
                    <button onClick={() => selectTab('game')} className="flex h-[30px] items-center gap-1.5 rounded-full bg-warn/[0.14] px-3 text-[12.5px] font-semibold text-warn hover:bg-warn/25" title="Pedidos de amizade pendentes">
                      <IconStar /> {game.pendingRequests.length} {game.pendingRequests.length === 1 ? 'pedido' : 'pedidos'}
                    </button>
                  </>
                )}
              </div>

              {/* Add User All ativo: leitura de relance no canto */}
              {addallOn && (
                <div className="glass animate-rise pointer-events-none absolute left-4 top-4 z-30 flex h-[34px] items-center gap-3.5 rounded-full px-3.5">
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-dim">Add User All</span>
                  <Stat tone="warn" label="na fila" value={stats.queue} />
                  <Stat tone="accent" label="enviados" value={stats.done} />
                  {(stats.ignored ?? 0) > 0 && <Stat tone="muted" label="ignorados" value={stats.ignored ?? 0} />}
                  {(stats.notAcceptingRequests ?? 0) > 0 && <Stat tone="muted" label="não aceita" value={stats.notAcceptingRequests ?? 0} />}
                </div>
              )}

              {/* Dock: recolhido é uma barra fina; aberto é uma folha em vidro que sobe sobre o jogo */}
              {panelCollapsed ? (
                <div className="glass-strong animate-rise absolute bottom-3.5 left-1/2 z-30 flex h-[52px] w-[760px] max-w-[calc(100%-28px)] -translate-x-1/2 items-center gap-1 rounded-2xl pl-2.5 pr-2 shadow-dock">
                  <DockTabs panelTab={null} onSelect={selectTab} roomUserCount={roomUserCount} agentReady={protocol.agentReady} crowdOnline={crowdOnline} crowdConnected={crowdConnected} />
                  <span className="flex-1" />
                  <span className="pr-2 text-[11px] text-dim">Ctrl+J</span>
                  <button onClick={() => setPanelCollapsed(false)} className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-fg/[0.06] text-fg hover:bg-fg/10" title="Expandir painel (Ctrl+J)" aria-label="Expandir painel"><IconChevron up /></button>
                </div>
              ) : (
                <section
                  className="glass-strong animate-rise absolute z-30 flex flex-col overflow-hidden rounded-[20px] shadow-sheet"
                  style={{ left: STAGE_INSET, right: STAGE_INSET, bottom: STAGE_INSET, height: Math.min(panelHeight + 44, Math.round(window.innerHeight * 0.85)) }}
                >
                  <div
                    role="separator"
                    aria-label="Redimensionar painel"
                    onMouseDown={(e) => { e.preventDefault(); panelResizeRef.current = { startY: e.clientY, startH: panelHeight }; setIsResizingPanel(true); }}
                    className="group absolute inset-x-0 top-0 z-10 flex h-3 cursor-ns-resize items-center justify-center"
                    title="Arrastar para redimensionar"
                  >
                    <span className="mt-1 h-1 w-10 rounded-full bg-line-strong group-hover:bg-accent" />
                  </div>
                  <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-3 pt-1">
                    <DockTabs panelTab={panelTab} onSelect={selectTab} roomUserCount={roomUserCount} agentReady={protocol.agentReady} crowdOnline={crowdOnline} crowdConnected={crowdConnected} />
                    <div className="ml-auto flex items-center gap-1">
                      {panelTab === 'logs' && (
                        <>
                          <div className="flex items-center gap-0.5 rounded-full border border-line bg-fg/[0.045] p-[3px]">
                            <LogChip active={logFilter === 'all'} onClick={() => setLogFilter('all')} count={logs.length}>Tudo</LogChip>
                            {LOG_SOURCES.map((src) => <LogChip key={src.id} active={logFilter === src.id} onClick={() => setLogFilter(src.id)} count={logCounts[src.id]}>{src.label}</LogChip>)}
                          </div>
                          <Input size="sm" type="text" value={logText} onChange={(e) => setLogText(e.target.value)} placeholder="filtrar texto ou conta" className="w-44" />
                          <Button variant="ghost" size="sm" onClick={clearLogs}>Limpar</Button>
                          <Button variant="ghost" size="sm" onClick={exportLogs}>Exportar</Button>
                        </>
                      )}
                      {panelTab === 'board' && (
                        <>
                          <Input size="sm" type="text" value={boardFilter} onChange={(e) => setBoardFilter(e.target.value)} placeholder="filtrar nomes" className="w-40" />
                          <Button variant="ghost" size="sm" onClick={exportBoard}>Exportar</Button>
                        </>
                      )}
                      <button onClick={() => setPanelCollapsed(true)} className="ml-1 flex h-[30px] w-[30px] items-center justify-center rounded-[10px] bg-fg/[0.06] text-fg hover:bg-fg/10" title="Recolher painel (Ctrl+J)" aria-label="Recolher painel"><IconChevron up={false} /></button>
                    </div>
                  </div>
                  <div className="flex min-h-0 flex-1 overflow-hidden">
                    {panelTab === 'logs' && (
                      <div className="flex-1 overflow-y-auto font-mono text-[11px] text-fg-2">
                        {visibleLogs.length === 0 ? (
                          <EmptyHint>{logs.length === 0 ? 'Nenhum log ainda. Ative um addon ou conecte uma conta para ver a atividade.' : 'Nada corresponde ao filtro.'}</EmptyHint>
                        ) : (
                          <div className="px-3 py-1.5">
                            {visibleLogs.map((l, i) => {
                              const src = LOG_SOURCES.find((x) => x.id === logSource(l.msg));
                              return (
                                <div key={i} className="flex gap-3 rounded px-1 py-0.5 hover:bg-fg/[0.04]">
                                  <span className="tnum shrink-0 text-dim">{new Date(l.t).toLocaleTimeString('pt-BR', { hour12: false })}</span>
                                  {logFilter === 'all' && src && <span className={cx('w-1 shrink-0 self-stretch rounded-full', src.bar)} title={src.label} />}
                                  <span className="min-w-0 break-words">{l.msg}</span>
                                </div>
                              );
                            })}
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
                      <div className="grid flex-1 grid-cols-5 gap-2 overflow-auto p-3">
                        <BoardColumn title="Fila" names={filtered.q} variant="warning" />
                        <BoardColumn title="Processando" names={filtered.pr} variant="blue" />
                        <BoardColumn title="Enviados" names={filtered.dn} variant="success" />
                        <BoardColumn title="Ignorados" names={filtered.ig} variant="muted" />
                        <BoardColumn title="Não aceita" names={filtered.nar} variant="muted" />
                      </div>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>

      {/* Camada única das telas da Multidão: um host fixo posicionado sobre o espaço das telas.
          Os <webview> das contas vivem DENTRO dele, criados à mão (CrowdGuestHost); mostramos um
          por vez trocando só o CSS, sem nunca reparentar/recarregar o guest. */}
      <div
        ref={crowdHostRef}
        className={crowdCtl.guestsVisible ? 'fixed z-40 overflow-hidden rounded-xl bg-black' : 'fixed overflow-hidden'}
        style={crowdCtl.guestsVisible && crowdCtl.tilesRect
          ? { left: crowdCtl.tilesRect.x, top: crowdCtl.tilesRect.y, width: crowdCtl.tilesRect.w, height: crowdCtl.tilesRect.h }
          : { left: -20000, top: 0, width: 1280, height: 720, pointerEvents: 'none' }}
      />
      {crowdCtl.guestsVisible && crowdCtl.tilesRect && crowdCtl.selectedSession?.status === 'captcha' && (
        <div
          className="pointer-events-none fixed z-50 rounded-full bg-warn px-3 py-1 text-[11px] font-semibold text-accent-ink shadow-float"
          style={{ left: crowdCtl.tilesRect.x + 8, top: crowdCtl.tilesRect.y + 8, maxWidth: crowdCtl.tilesRect.w - 16 }}
        >
          {crowdCtl.selectedSession.account.username} · {crowdCtl.selectedSession.detail}
        </div>
      )}

      {paletteOpen && <Palette
        onClose={() => setPaletteOpen(false)}
        currentUrl={webviewSrc}
        enabled={store.enabled}
        serverCommands={crowdCtl.snap.commands}
        crowdOnline={crowdOnline}
        onNavigate={(u) => { setUrlInput(u); setWebviewSrc(u); }}
        onReload={() => nav('reload')}
        onTab={(t) => { setPanelTab(t); setPanelCollapsed(false); if ((t === 'crowd' || t === 'game') && panelHeight < 420) setPanelHeight(Math.min(Math.round(window.innerHeight * 0.6), 460)); }}
        onGameOnly={() => setPanelCollapsed(true)}
        onOpenAddons={(id) => { setAddonsPageOpen(true); setAddonSettingsOpen(id ?? null); }}
        onToggleAddon={onToggleAddon}
        onCrowdCommand={(cmd) => crowdCtl.panelProps.onCommand(null, cmd)}
        onExportProfile={exportProfile}
        onImportProfile={importProfile}
      />}

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

      {/* Toast: uma ilha pequena que sobe do rodapé */}
      <div className={`glass-strong pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-[12.5px] text-fg shadow-float transition-all duration-200 ${toast.show ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'}`}>
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

function NavItem({ active, onClick, children, badge, badgeTone, dot, title }: { active: boolean; onClick: () => void; children: ReactNode; badge?: number | string; badgeTone?: 'accent' | 'warn'; dot?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-current={active ? 'page' : undefined}
      className={cx('flex h-[30px] items-center gap-2 whitespace-nowrap rounded-full px-4 text-[13px] transition-colors', active ? 'bg-fg/10 font-semibold text-fg' : 'font-medium text-muted hover:text-fg')}
    >
      {children}
      {badge !== undefined && <span className={cx('tnum font-mono text-[11px]', badgeTone === 'warn' ? 'text-warn' : 'text-accent')}>{badge}</span>}
      {dot && <LiveDot size={6} />}
    </button>
  );
}

/** Abas do dock (barra recolhida e cabeçalho da folha). `panelTab` null = nenhuma ativa (barra recolhida). */
function DockTabs({ panelTab, onSelect, roomUserCount, agentReady, crowdOnline, crowdConnected }: { panelTab: PanelTab | null; onSelect: (t: PanelTab) => void; roomUserCount: number; agentReady: boolean; crowdOnline: number; crowdConnected: number }) {
  return (
    <>
      <Tab active={panelTab === 'logs'} onClick={() => onSelect('logs')}>Logs</Tab>
      <Tab active={panelTab === 'board'} onClick={() => onSelect('board')}>Board</Tab>
      <Tab active={panelTab === 'game'} onClick={() => onSelect('game')}>
        Sala{roomUserCount > 0 && <span className="tnum font-mono text-[11px] text-dim">{roomUserCount}</span>}
      </Tab>
      <Tab active={panelTab === 'protocol'} onClick={() => onSelect('protocol')}>
        Protocolo{agentReady && <LiveDot size={6} />}
      </Tab>
      <Tab active={panelTab === 'crowd'} onClick={() => onSelect('crowd')}>
        Multidão{crowdConnected > 0 && <span className="tnum font-mono text-[11px] text-accent">{crowdOnline}/{crowdConnected}</span>}
      </Tab>
    </>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={cx('flex h-[34px] items-center gap-2 whitespace-nowrap rounded-[10px] px-3.5 text-[13px] font-medium transition-colors', active ? 'bg-fg/10 text-fg' : 'text-muted hover:text-fg')}>
      {children}
    </button>
  );
}

function LogChip({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: ReactNode }) {
  return (
    <button onClick={onClick} className={cx('flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11px] font-medium transition-colors', active ? 'bg-fg/10 text-fg' : 'text-muted hover:text-fg')}>
      {children}
      <span className="tnum font-mono text-[10px] text-dim">{count}</span>
    </button>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-fg/[0.06] hover:text-fg">
      {children}
    </button>
  );
}

function Stat({ tone, label, value }: { tone: 'warn' | 'accent' | 'muted'; label: string; value: number }) {
  const tones = { warn: 'text-warn', accent: 'text-accent', muted: 'text-muted' };
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={cx('tnum font-mono text-[13px]', tones[tone])}>{value}</span>
      <span className="text-[11px] text-dim">{label}</span>
    </span>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-dim">{children}</div>;
}

/** Tela de abertura: a marca em órbita, o endereço e os três passos. */
function EmptyState({ urlInput, onUrlChange, onGo, onShortcut, onAddons }: { urlInput: string; onUrlChange: (v: string) => void; onGo: () => void; onShortcut: (url: string) => void; onAddons: () => void }) {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden">
      {/* Anéis orbitais lentos atrás da marca */}
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-[1100px] w-[1100px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-line/60" />
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-[760px] w-[760px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-line border-t-fg/25 animate-orbit-slow" />
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-[460px] w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-line-strong/70" />

      <div className="relative flex flex-col items-center gap-9 px-6">
        <div className="animate-rise flex flex-col items-center gap-6">
          <BrandMark size={64} />
          <div className="flex flex-col items-center gap-2.5">
            <h1 className="wordmark m-0 text-[44px] font-medium tracking-[0.32em] text-fg">Universe</h1>
            <p className="m-0 text-[14px] text-muted">O jogo por dentro: pacotes, não cliques.</p>
          </div>
        </div>
        <div className="animate-rise flex items-center gap-2.5" style={{ animationDelay: '120ms' }}>
          <div className="glass flex h-11 w-[420px] items-center gap-2.5 rounded-full border-line-strong pl-4 pr-1.5">
            <IconGlobe />
            <input
              type="text"
              value={urlInput}
              onChange={(e) => onUrlChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onGo()}
              placeholder="habblet.city/hotel"
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder-dim"
            />
            <button onClick={onGo} className="h-8 rounded-full bg-fg px-4 text-[12.5px] font-bold text-bg hover:bg-white">Entrar</button>
          </div>
        </div>
        <div className="animate-rise flex items-center gap-2" style={{ animationDelay: '180ms' }}>
          {URL_SHORTCUTS.map((s) => (
            <button key={s.url} onClick={() => onShortcut(s.url)} className="h-8 rounded-full border border-line-strong px-4 text-[12.5px] font-medium text-muted hover:border-dim hover:text-fg" title={s.url}>{s.label}</button>
          ))}
        </div>
        <ol className="animate-rise m-0 flex list-none gap-10 p-0" style={{ animationDelay: '220ms' }}>
          <Step n="01">Abra o hotel e faça login</Step>
          <Step n="02">Entre num quarto</Step>
          <Step n="03">Ligue o que precisar em <button onClick={onAddons} className="font-semibold text-fg hover:text-accent">Addons</button></Step>
        </ol>
      </div>
      <footer className="absolute bottom-0 flex h-12 items-center justify-center gap-4 text-[11px] text-dim">
        <span>Ctrl+K paleta</span><span>·</span><span>Ctrl+J painel</span><span>·</span><span>Ctrl+, addons</span><span>·</span>
        <span className="font-mono">build {BUILD_MODE === 'dev' ? 'de desenvolvimento' : BUILD_LABEL}</span>
      </footer>
    </div>
  );
}

function Step({ n, children }: { n: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3 text-[13px] text-muted">
      <span className="tnum font-mono text-[11px] text-dim">{n}</span>
      <span>{children}</span>
    </li>
  );
}

/* ------------------------------------ ícones ------------------------------------ */
function IconGlobe() { return <svg className="h-3.5 w-3.5 shrink-0 text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></svg>; }
function IconDoor() { return <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M5 21V5a2 2 0 012-2h10a2 2 0 012 2v16M3 21h18M15 12h.01" /></svg>; }
function IconStar() { return <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.6 7.1.7-5.4 4.8 1.6 7L12 17.5 5.8 21l1.6-7L2 9.3l7.1-.7L12 2z" /></svg>; }
function IconArrow({ dir }: { dir: 'left' | 'right' }) { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d={dir === 'left' ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'} /></svg>; }
function IconReload({ spinning }: { spinning: boolean }) { return <svg className={`h-3.5 w-3.5 ${spinning ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M5.6 15A7 7 0 0019 12M18.4 9A7 7 0 005 12" /></svg>; }
function IconChevron({ up }: { up: boolean }) { return <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d={up ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'} /></svg>; }
