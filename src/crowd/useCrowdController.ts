/**
 * Controlador da Multidão para o React: cria o CrowdManager e o host dos webviews, carrega contas,
 * resolvedor e Tor pelo IPC, e devolve as props prontas do CrowdPanel. O App só renderiza.
 *
 * Tudo que é da Multidão fica aqui (antes vivia em ~180 linhas do App.tsx).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AddonConfigMap } from '../../shared/addon-config';
import type { CaptchaSolverProvider, CaptchaSolverSettings, CrowdAccount, CrowdNetworkSettings, ProxyPoolEntry, ProxyPoolStatus, TorSettings, TorStatus, TrafficReport } from '../../shared/crowd';
import { defaultCrowdNetworkSettings } from '../../shared/crowd';
import type { FurniCatalog, WallCatalog } from '../../shared/furnidata';
import type { CrowdPanelProps } from '../components/CrowdPanel';
import { CrowdManager } from './CrowdManager';
import type { CrowdCommand, CrowdSessionView, CrowdSnapshot } from './CrowdManager';
import { CrowdGuestHost } from './CrowdGuestHost';
import { useCrowd } from './useCrowd';

export interface TilesRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CrowdControllerOptions {
  /** Logs da multidão também vão para o painel Logs da janela principal. */
  log: (msg: string) => void;
  configs: AddonConfigMap;
  /** file:// do preload do webview; os guests só são criados depois que ele existe. */
  webviewPreload: string | null;
  /** A aba Multidão está aberta no dock (as telas só aparecem então). */
  panelVisible: boolean;
  /** Muda quando o layout do dock muda (altura, recolhido, aba): remede o espaço das telas. */
  layoutKey: string;
  showToast: (msg: string) => void;
}

export interface CrowdController {
  snap: CrowdSnapshot;
  accounts: CrowdAccount[];
  /** Conta exibida na tela única. Derivada: a escolha do usuário enquanto válida; senão, quem está em captcha; senão, a primeira. */
  viewId: string | null;
  selectedSession: CrowdSessionView | null;
  /** As telas das contas estão visíveis (aba aberta e "mostrar" ligado). */
  guestsVisible: boolean;
  /** Retângulo (na janela) onde a camada fixa dos webviews deve ficar. */
  tilesRect: TilesRect | null;
  /** Ref do host fixo dentro do qual os <webview> das contas vivem. */
  attachHost: (el: HTMLDivElement | null) => void;
  /** Props prontas para o CrowdPanel (falta só o showToast). */
  panelProps: Omit<CrowdPanelProps, 'showToast'>;
  /** Catálogo de mobis de chão (furnidata), ou null enquanto carrega / se falhou. */
  furniCatalog: FurniCatalog | null;
  /** Catálogo de mobis de parede (furnidata). */
  wallCatalog: WallCatalog | null;
}

const DEFAULT_TOR: { settings: TorSettings; status: TorStatus } = {
  settings: { enabled: false, host: '127.0.0.1', basePort: 9050, count: 20, torExePath: null },
  status: { running: false, torrcPath: '', error: null, torExe: null },
};

function cleanErr(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e);
}

export function useCrowdController(o: CrowdControllerOptions): CrowdController {
  const { log, configs, webviewPreload, panelVisible, layoutKey, showToast } = o;

  const crowd = useMemo(() => new CrowdManager(), []);
  const snap = useCrowd(crowd);
  const guestHost = useMemo(() => new CrowdGuestHost(crowd, null), [crowd]);
  const [accounts, setAccounts] = useState<CrowdAccount[]>([]);
  const [showTiles, setShowTiles] = useState(true);
  const [chosenViewId, setChosenViewId] = useState<string | null>(null);
  const [solver, setSolver] = useState<CaptchaSolverSettings>({ provider: 'none', hasKey: false });
  const [tor, setTor] = useState(DEFAULT_TOR);
  const [network, setNetwork] = useState<CrowdNetworkSettings>(defaultCrowdNetworkSettings);
  const [traffic, setTraffic] = useState<TrafficReport[]>([]);
  const [proxies, setProxies] = useState<ProxyPoolEntry[]>([]);
  const [tilesRect, setTilesRect] = useState<TilesRect | null>(null);
  const tilesObserverRef = useRef<ResizeObserver | null>(null);
  const tilesElRef = useRef<HTMLDivElement | null>(null);

  /* ------------------------------ ciclo de vida do manager ------------------------------ */
  useEffect(() => {
    crowd.setExternalLog(log);
    return () => crowd.setExternalLog(null);
  }, [crowd, log]);
  useEffect(() => {
    crowd.setConfigs(configs);
  }, [crowd, configs]);
  useEffect(() => () => crowd.dispose(), [crowd]);

  /* ------------------------------ carga inicial (contas, resolvedor, Tor) ------------------------------ */
  useEffect(() => {
    const api = window.habblet?.crowd;
    if (!api) return;
    let alive = true;
    api.list().then((list) => { if (alive) { setAccounts(list); crowd.setAccounts(list); } }).catch(() => {});
    api.getSolver().then((s) => { if (alive) setSolver(s); }).catch(() => {});
    api.getTor().then((t) => { if (alive) setTor(t); }).catch(() => {});
    api.getNetwork().then((n) => { if (alive) setNetwork(n); }).catch(() => {});
    api.listProxies().then((l) => { if (alive) setProxies(l); }).catch(() => {});
    return () => { alive = false; };
  }, [crowd]);

  /* ------------------------------ furnidata (mobis sentáveis/deitáveis) ------------------------------ */
  const [furniCatalog, setFurniCatalog] = useState<FurniCatalog | null>(null);
  const [wallCatalog, setWallCatalog] = useState<WallCatalog | null>(null);
  useEffect(() => {
    const api = window.habblet?.game;
    if (!api) return;
    let alive = true;
    api.furnidata().then((r) => {
      if (!alive) return;
      if (r.ok) {
        setFurniCatalog(r.catalog);
        setWallCatalog(r.walls);
        crowd.setFurniCatalog(r.catalog);
        const sittable = Object.values(r.catalog).filter((f) => f.sit || f.lay).length;
        log(`[multidão] furnidata: ${r.total} mobis de chão (${sittable} sentáveis/deitáveis) e ${Object.keys(r.walls).length} de parede (${r.fromCache ? 'cache' : 'baixado agora'}, ${new Date(r.fetchedAt).toLocaleDateString('pt-BR')}).`);
      } else {
        log(`[multidão] furnidata indisponível (${r.error}): "sentar todas" só vai usar casas onde alguém já foi visto sentado.`);
      }
    }).catch((e: unknown) => { if (alive) log('[multidão] furnidata: ' + cleanErr(e)); });
    return () => { alive = false; };
  }, [crowd, log]);

  /* ------------------------------ rede: modo sem tela, escopo do proxy, tráfego ------------------------------ */
  useEffect(() => {
    crowd.setNetwork(network);
  }, [crowd, network]);

  // Ponte com o cliente do jogo sem tela (processo principal) e seus eventos.
  useEffect(() => {
    const api = window.habblet?.crowd;
    if (!api) return;
    crowd.setHeadlessBridge({
      connect: (id, hs) => api.headlessConnect(id, hs),
      send: (id, header, body) => api.headlessSend(id, header, body),
      disconnect: (id) => api.headlessDisconnect(id),
    });
    const unsub = api.onHeadlessEvent((ev) => crowd.onHeadlessEvent(ev));
    return () => {
      unsub();
      crowd.setHeadlessBridge(null);
    };
  }, [crowd]);

  const onSetNetwork = useCallback(async (patch: Partial<CrowdNetworkSettings>) => {
    try {
      const next = await window.habblet.crowd.setNetwork(patch);
      setNetwork(next);
      if (patch.mode) showToast(next.mode === 'headless' ? 'Modo sem tela: vale para as próximas conexões.' : 'Modo com tela: vale para as próximas conexões.');
      else if (patch.proxyScope || patch.gameHosts) showToast('Escopo do proxy salvo. Reconecte as contas para aplicar.');
      else if (patch.proxyAfterLogin !== undefined) showToast(next.proxyAfterLogin ? 'Proxy depois do login ligado: vale para as próximas conexões.' : 'Proxy desde o login.');
    } catch (e) {
      showToast(cleanErr(e));
    }
  }, [showToast]);

  // Medidor de tráfego: só enquanto a aba está aberta.
  useEffect(() => {
    const api = window.habblet?.crowd;
    if (!api || !panelVisible) return;
    let alive = true;
    const load = () => { api.getTraffic().then((t) => { if (alive) setTraffic(t); }).catch(() => {}); };
    load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [panelVisible]);
  const onResetTraffic = useCallback(async () => {
    try {
      await window.habblet.crowd.resetTraffic();
      setTraffic(await window.habblet.crowd.getTraffic());
    } catch { /* fora do Electron */ }
  }, []);

  const refreshAccounts = useCallback(async () => {
    const api = window.habblet?.crowd;
    if (!api) return;
    try {
      const list = await api.list();
      setAccounts(list);
      crowd.setAccounts(list);
    } catch { /* fora do Electron */ }
  }, [crowd]);

  /* ------------------------------ resolvedor de captcha ------------------------------ */
  useEffect(() => {
    crowd.setSolver(solver.provider !== 'none' && solver.hasKey ? (req) => window.habblet.crowd.solveTurnstile(req) : null);
  }, [crowd, solver]);

  const onSetSolver = useCallback(async (provider: CaptchaSolverProvider, apiKey: string | null) => {
    try {
      setSolver(await window.habblet.crowd.setSolver(provider, apiKey));
      showToast(provider === 'none' ? 'Captcha automático desligado' : apiKey ? 'Chave do resolvedor salva' : `Resolvedor: ${provider}`);
    } catch (e) {
      showToast(cleanErr(e));
    }
  }, [showToast]);

  /* ------------------------------ Tor ------------------------------ */
  const onSetTor = useCallback(async (patch: Partial<TorSettings>) => {
    try { setTor(await window.habblet.crowd.setTor(patch)); } catch (e) { showToast(cleanErr(e)); }
  }, [showToast]);
  const onLaunchTor = useCallback(async () => {
    try {
      const st = await window.habblet.crowd.launchTor();
      setTor((t) => ({ ...t, status: st }));
      showToast(st.running ? 'Tor iniciado' : st.error ? `Tor: ${st.error}` : 'Tor não iniciou');
    } catch (e) { showToast(cleanErr(e)); }
  }, [showToast]);
  const onStopTor = useCallback(async () => {
    try { const st = await window.habblet.crowd.stopTor(); setTor((t) => ({ ...t, status: st })); showToast('Tor parado'); } catch { /* noop */ }
  }, [showToast]);
  const onGenerateTorrc = useCallback(async () => {
    try { const r = await window.habblet.crowd.generateTorrc(); showToast(`torrc gerado (${r.ports.length} portas): ${r.path}`); } catch (e) { showToast(cleanErr(e)); }
  }, [showToast]);

  /* ------------------------------ conexão ------------------------------ */
  const getCredentials = useCallback((id: string) => window.habblet.crowd.credentials(id), []);
  const applyProxy = useCallback((id: string, phase: 'login' | 'game') => window.habblet.crowd.applyProxy(id, phase), []);
  const onConnect = useCallback((id: string) => { void crowd.connect(id, getCredentials, applyProxy); }, [crowd, getCredentials, applyProxy]);
  const onConnectAll = useCallback(() => { crowd.enqueue(accounts.map((a) => a.id), getCredentials, applyProxy); }, [crowd, accounts, getCredentials, applyProxy]);
  const onDisconnect = useCallback((id: string) => crowd.disconnect(id), [crowd]);
  const onDisconnectAll = useCallback(() => { crowd.clearQueue(); for (const s of snap.sessions) crowd.disconnect(s.id); }, [crowd, snap.sessions]);
  const onPause = useCallback((id: string, v: boolean) => crowd.setPaused(id, v), [crowd]);

  // Conexão automática: uma vez por abertura do app, assim que as contas e o preload do webview existirem.
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (autoConnectedRef.current || !webviewPreload || accounts.length === 0) return;
    autoConnectedRef.current = true;
    const auto = accounts.filter((a) => a.autoConnect);
    if (auto.length === 0) return;
    log(`[multidão] conectando ${auto.length} conta(s) marcada(s) como automática(s), pela fila.`);
    crowd.enqueue(auto.map((a) => a.id), getCredentials, applyProxy);
  }, [accounts, webviewPreload, crowd, getCredentials, applyProxy, log]);

  /* ------------------------------ contas ------------------------------ */
  const onAddAccount = useCallback(async (username: string, password: string, label: string, proxy: string) => {
    try {
      await window.habblet.crowd.add({ username, password, label, proxy: proxy || undefined });
      await refreshAccounts();
      showToast(`Conta ${username} cadastrada`);
    } catch (e) {
      showToast(cleanErr(e));
    }
  }, [refreshAccounts, showToast]);
  const onRemoveAccount = useCallback(async (id: string) => {
    crowd.disconnect(id);
    await window.habblet.crowd.remove(id);
    await refreshAccounts();
  }, [crowd, refreshAccounts]);
  const onSetAutoConnect = useCallback(async (id: string, autoConnect: boolean) => {
    try {
      await window.habblet.crowd.update(id, { autoConnect });
      await refreshAccounts();
    } catch (e) {
      showToast(cleanErr(e));
    }
  }, [refreshAccounts, showToast]);

  /* ------------------------------ proxies ------------------------------ */
  const onSetProxy = useCallback(async (id: string, proxy: string) => {
    try {
      await window.habblet.crowd.update(id, { proxy });
      await refreshAccounts();
      showToast(proxy ? 'Proxy salvo. Reconecte a conta para aplicar.' : 'Proxy removido.');
    } catch (e) {
      showToast(cleanErr(e));
    }
  }, [refreshAccounts, showToast]);
  const onTestProxy = useCallback(async (id: string) => {
    const r = await window.habblet.crowd.testProxy(id);
    if (r.ok) { crowd.setExitIp(id, r.ip); showToast(r.via === 'proxy' ? `IP de saída pelo proxy (o que o jogo vê): ${r.ip}` : `Sem proxy nesta conta: IP real ${r.ip}`); }
    else { crowd.setExitIp(id, null); showToast(r.error); }
  }, [crowd, showToast]);
  const onDistributeProxies = useCallback(async (proxies: string[]) => {
    let n = 0;
    for (let i = 0; i < Math.min(proxies.length, accounts.length); i++) {
      try { await window.habblet.crowd.update(accounts[i].id, { proxy: proxies[i] }); n++; } catch { /* proxy inválido: pula */ }
    }
    await refreshAccounts();
    showToast(`${n} proxy(s) atribuído(s). Reconecte as contas para aplicar.`);
  }, [accounts, refreshAccounts, showToast]);

  /* ------------------------------ pool de proxies ------------------------------ */
  const refreshProxies = useCallback(async () => {
    try { setProxies(await window.habblet.crowd.listProxies()); } catch { /* fora do Electron */ }
  }, []);
  const onAddProxies = useCallback(async (text: string) => {
    try {
      const r = await window.habblet.crowd.addProxies(text);
      await refreshProxies();
      const parts = [`${r.added.length} proxy(s) adicionado(s) ao pool`];
      if (r.existing) parts.push(`${r.existing} já estavam`);
      if (r.duplicates) parts.push(`${r.duplicates} repetido(s) no texto`);
      if (r.invalid.length) parts.push(`${r.invalid.length} inválido(s)`);
      showToast(parts.join(' · '));
      for (const inv of r.invalid.slice(0, 5)) log(`[multidão] pool: linha inválida "${inv.line}": ${inv.error}`);
    } catch (e) {
      showToast(cleanErr(e));
    }
  }, [refreshProxies, showToast, log]);
  const onRemoveProxy = useCallback(async (id: string) => {
    try {
      await window.habblet.crowd.removeProxy(id);
      await Promise.all([refreshProxies(), refreshAccounts()]);
    } catch (e) {
      showToast(cleanErr(e));
    }
  }, [refreshProxies, refreshAccounts, showToast]);
  const onSetProxyStatus = useCallback(async (id: string, status: ProxyPoolStatus, note?: string) => {
    try {
      await window.habblet.crowd.updateProxy(id, { status, note: note ?? null });
      await refreshProxies();
    } catch (e) {
      showToast(cleanErr(e));
    }
  }, [refreshProxies, showToast]);
  const onSetProxyLabel = useCallback(async (id: string, label: string) => {
    try {
      await window.habblet.crowd.updateProxy(id, { label });
      await refreshProxies();
    } catch (e) {
      showToast(cleanErr(e));
    }
  }, [refreshProxies, showToast]);
  const onTestPoolProxy = useCallback(async (id: string) => {
    const r = await window.habblet.crowd.testPoolProxy(id);
    await refreshProxies();
    showToast(r.ok ? `IP de saída: ${r.ip}` : r.error);
    return r;
  }, [refreshProxies, showToast]);
  /** Escolhe (ou tira, com null) o item do pool que a conta usa. Vale na próxima conexão. */
  const onAssignProxy = useCallback(async (accountId: string, proxyId: string | null) => {
    try {
      await window.habblet.crowd.update(accountId, { proxyId });
      await refreshAccounts();
      const connected = snap.sessions.some((s) => s.id === accountId);
      showToast(proxyId ? (connected ? 'Proxy escolhido. Reconecte a conta para aplicar.' : 'Proxy escolhido para a próxima conexão.') : (connected ? 'Conta fora do pool. Reconecte para aplicar.' : 'Conta fora do pool.'));
    } catch (e) {
      showToast(cleanErr(e));
    }
  }, [refreshAccounts, showToast, snap.sessions]);
  /** Dá um proxy livre do pool (não bloqueado, não usado por outra conta) a cada conta sem proxy, em ordem. */
  const onAutoAssignProxies = useCallback(async () => {
    const used = new Set(accounts.map((a) => a.proxyId).filter((x): x is string => !!x));
    const free = proxies.filter((p) => p.status !== 'blocked' && p.status !== 'error' && !used.has(p.id));
    const targets = accounts.filter((a) => !a.proxyId && !a.hasOwnProxy);
    let n = 0;
    for (let i = 0; i < Math.min(free.length, targets.length); i++) {
      try { await window.habblet.crowd.update(targets[i].id, { proxyId: free[i].id }); n++; } catch { /* segue */ }
    }
    await refreshAccounts();
    showToast(n === 0
      ? (targets.length === 0 ? 'Todas as contas já têm proxy.' : 'Nenhum proxy livre no pool (todos em uso, bloqueados ou com erro).')
      : `${n} conta(s) receberam um proxy do pool. Reconecte para aplicar.`);
  }, [accounts, proxies, refreshAccounts, showToast]);

  // O pool aprende com o uso: conta online = proxy ok; site recusou o login (anti-VPN) = proxy bloqueado;
  // não deu para sair pelo proxy = erro. Só para contas que usam um item do pool.
  const accountsRef = useRef(accounts);
  useEffect(() => { accountsRef.current = accounts; }, [accounts]);
  useEffect(() => {
    const api = window.habblet?.crowd;
    if (!api) return;
    crowd.setStatusListener((accountId, status, detail) => {
      const proxyId = accountsRef.current.find((a) => a.id === accountId)?.proxyId;
      if (!proxyId) return;
      let patch: { status: ProxyPoolStatus; note: string | null } | null = null;
      if (status === 'online') patch = { status: 'ok', note: null };
      else if (status === 'error' && /login recusado/i.test(detail)) patch = { status: 'blocked', note: detail.replace(/^login recusado:\s*/i, '').slice(0, 160) };
      else if (status === 'error' && /proxy/i.test(detail)) patch = { status: 'error', note: detail.slice(0, 160) };
      if (!patch) return;
      api.updateProxy(proxyId, patch).then(() => refreshProxies()).catch(() => {});
    });
    return () => crowd.setStatusListener(null);
  }, [crowd, refreshProxies]);

  /* ------------------------------ tela única ------------------------------ */
  const ids = snap.connectedIds;
  const viewId = useMemo(() => {
    if (ids.length === 0) return null;
    // Não rouba a seleção do usuário enquanto ela for válida (mesmo com outra conta em captcha).
    if (chosenViewId && ids.includes(chosenViewId)) return chosenViewId;
    const captcha = snap.sessions.find((s) => s.status === 'captcha' && ids.includes(s.id));
    return captcha ? captcha.id : ids[0];
  }, [ids, chosenViewId, snap.sessions]);
  const selectedSession = snap.sessions.find((s) => s.id === viewId) ?? null;
  const guestsVisible = panelVisible && showTiles;

  // Guests criados imperativamente (CrowdGuestHost) e sincronizados com as sessões conectadas.
  useEffect(() => { guestHost.setPreload(webviewPreload); }, [guestHost, webviewPreload]);
  const attachHost = useCallback((el: HTMLDivElement | null) => { guestHost.setHost(el); }, [guestHost]);
  const connectedKey = ids.join(',');
  useEffect(() => {
    guestHost.sync(connectedKey ? connectedKey.split(',') : [], viewId);
  }, [guestHost, connectedKey, viewId, webviewPreload]);
  useEffect(() => () => guestHost.dispose(), [guestHost]);

  // Só atualiza o estado quando o retângulo muda de fato (evita laço de renderização).
  const measureTiles = useCallback(() => {
    const el = tilesElRef.current;
    if (!el) { setTilesRect((prev) => (prev === null ? prev : null)); return; }
    const r = el.getBoundingClientRect();
    const next = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    setTilesRect((prev) => (prev && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : next));
  }, []);
  // Ref de callback ESTÁVEL: uma função nova a cada render faria o React chamá-la em todo commit → setState → laço.
  const onTilesPlaceholder = useCallback((el: HTMLDivElement | null) => {
    tilesObserverRef.current?.disconnect();
    tilesObserverRef.current = null;
    tilesElRef.current = el;
    if (!el) { measureTiles(); return; }
    measureTiles();
    const ro = new ResizeObserver(() => measureTiles());
    ro.observe(el);
    tilesObserverRef.current = ro;
  }, [measureTiles]);
  // Remede quando o dock muda de tamanho/aba ou a janela muda de tamanho.
  useEffect(() => {
    measureTiles();
    window.addEventListener('resize', measureTiles);
    return () => window.removeEventListener('resize', measureTiles);
  }, [layoutKey, measureTiles]);

  /* ------------------------------ comandos ------------------------------ */
  const onCommand = useCallback((ids: string[] | null, cmd: CrowdCommand) => {
    const r = crowd.execute(ids, cmd);
    showToast(r.count === 0 && cmd.kind !== 'unpin' && cmd.kind !== 'cancelPosture' ? (cmd.kind === 'posture' ? 'Nenhuma conta online dentro de um quarto' : cmd.kind === 'standUp' ? 'Nenhuma conta sentada ou deitada' : 'Nenhuma conta online e não pausada para executar') : r.text);
  }, [crowd, showToast]);
  const onToggleAddon = useCallback<CrowdPanelProps['onToggleAddon']>((id, v) => crowd.setAddonEnabled(id, v), [crowd]);

  const panelProps: Omit<CrowdPanelProps, 'showToast'> = {
    accounts,
    crowd: snap,
    showTiles,
    onToggleTiles: setShowTiles,
    onTilesPlaceholder,
    onAddAccount,
    onRemoveAccount,
    onSetAutoConnect,
    onConnect,
    onDisconnect,
    onConnectAll,
    onDisconnectAll,
    onPause,
    onCommand,
    onToggleAddon,
    onSetProxy,
    onTestProxy,
    onDistributeProxies,
    proxies,
    onAddProxies,
    onRemoveProxy,
    onSetProxyStatus,
    onSetProxyLabel,
    onTestPoolProxy,
    onAssignProxy,
    onAutoAssignProxies,
    solver,
    onSetSolver,
    tor: tor.settings,
    torStatus: tor.status,
    onSetTor,
    onGenerateTorrc,
    onLaunchTor,
    onStopTor,
    network,
    onSetNetwork,
    traffic,
    onResetTraffic,
    viewId,
    onSelectView: setChosenViewId,
    hasFurniCatalog: furniCatalog !== null,
  };

  return { snap, accounts, viewId, selectedSession, guestsVisible, tilesRect, attachHost, panelProps, furniCatalog, wallCatalog };
}
