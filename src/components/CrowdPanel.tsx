import { useState } from 'react';
import type { AddonId } from '../../shared/addon-config';
import type { CaptchaSolverProvider, CaptchaSolverSettings, CrowdAccount, CrowdNetworkSettings, CrowdSessionStatus, ProxyPoolEntry, ProxyPoolStatus, ProxyTestResult, TorSettings, TorStatus, TrafficReport } from '../../shared/crowd';
import type { CrowdCommand, CrowdSnapshot } from '../crowd/CrowdManager';
import { ADDONS } from '../addons/registry';
import { Switch } from './ConfigInputs';
import { Button, Card, Chip, Dot, EmptyState, Eyebrow, FormRow, IconButton, Input, Select, SegmentedTabs, SettingRow, StatusPill, TextArea, Toolbar } from './ui';
import { cx } from './cx';
import { cleanName, fmtBytes } from './text';
import { Avatar } from './Avatar';
import ProxyPoolView from './ProxyPoolView';
import { poolOptionText, sortPool } from './proxyPoolUi';
import CommandBar from './CommandBar';
import type { Tone } from './ui';

export interface CrowdPanelProps {
  accounts: CrowdAccount[];
  crowd: CrowdSnapshot;
  showTiles: boolean;
  onToggleTiles: (v: boolean) => void;
  /** Espaço onde a camada de webviews é posicionada (medido pelo App). */
  onTilesPlaceholder: (el: HTMLDivElement | null) => void;
  onAddAccount: (username: string, password: string, label: string, proxy: string) => Promise<void>;
  onRemoveAccount: (id: string) => Promise<void>;
  /** Liga/desliga a conexão automática da conta ao abrir o app. */
  onSetAutoConnect: (id: string, autoConnect: boolean) => Promise<void>;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onConnectAll: () => void;
  onDisconnectAll: () => void;
  onPause: (id: string, paused: boolean) => void;
  /** Executa um comando nas contas alvo (`ids` null = todas as online e não pausadas). */
  onCommand: (ids: string[] | null, cmd: CrowdCommand) => void;
  onToggleAddon: (id: AddonId, enabled: boolean) => void;
  /** Define/remove o proxy de uma conta (URL completa; vazio remove). */
  onSetProxy: (id: string, proxy: string) => Promise<void>;
  /** Testa o IP de saída de uma conta conectada. */
  onTestProxy: (id: string) => Promise<void>;
  /** Distribui uma lista de proxies (um por linha) entre as contas, em ordem. */
  onDistributeProxies: (proxies: string[]) => Promise<void>;
  /** Pool de proxies: lista colada de uma vez; cada conta escolhe um item no seletor da linha dela. */
  proxies: ProxyPoolEntry[];
  onAddProxies: (text: string) => Promise<void>;
  onRemoveProxy: (id: string) => Promise<void>;
  onSetProxyStatus: (id: string, status: ProxyPoolStatus, note?: string) => Promise<void>;
  onSetProxyLabel: (id: string, label: string) => Promise<void>;
  onTestPoolProxy: (id: string) => Promise<ProxyTestResult>;
  /** Liga a conta a um item do pool (null = sai do pool). Vale na próxima conexão. */
  onAssignProxy: (accountId: string, proxyId: string | null) => Promise<void>;
  /** Dá um proxy livre do pool a cada conta sem proxy. */
  onAutoAssignProxies: () => Promise<void>;
  /** Resolvedor de captcha. */
  solver: CaptchaSolverSettings;
  onSetSolver: (provider: CaptchaSolverProvider, apiKey: string | null) => Promise<void>;
  /** Modo Tor (IP por conta, grátis). */
  tor: TorSettings;
  torStatus: TorStatus;
  onSetTor: (patch: Partial<TorSettings>) => Promise<void>;
  onGenerateTorrc: () => Promise<void>;
  onLaunchTor: () => Promise<void>;
  onStopTor: () => Promise<void>;
  /** Rede: modo sem tela / webview, escopo do proxy, hosts do jogo, reconexão. */
  network: CrowdNetworkSettings;
  onSetNetwork: (patch: Partial<CrowdNetworkSettings>) => Promise<void>;
  /** Tráfego aproximado por conta. */
  traffic: TrafficReport[];
  onResetTraffic: () => Promise<void>;
  /** Tela única: qual conta está sendo exibida. */
  viewId: string | null;
  onSelectView: (id: string | null) => void;
  /** O catálogo do furnidata carregou (sem ele, "sentar" só usa casas onde alguém já foi visto sentado). */
  hasFurniCatalog: boolean;
  showToast: (m: string) => void;
}

const STATUS: Record<CrowdSessionStatus, { label: string; tone: Tone; solid?: boolean }> = {
  offline: { label: 'offline', tone: 'neutral' },
  loading: { label: 'carregando', tone: 'info' },
  'logging-in': { label: 'login', tone: 'warn' },
  hotel: { label: 'no hotel', tone: 'info' },
  online: { label: 'online', tone: 'accent' },
  captcha: { label: 'captcha', tone: 'warn', solid: true },
  error: { label: 'erro', tone: 'danger' },
};


/** Largura mínima das duas colunas de trabalho; abaixo disso o dock ganha rolagem horizontal em vez de esmagar os controles. */
const COL_ACCOUNTS = 'minmax(440px, 1fr)';
const COL_COMMANDS = 'minmax(340px, 0.9fr)';

export default function CrowdPanel(p: CrowdPanelProps) {
  const { onTilesPlaceholder } = p;
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(false);
  /** Contas alvo dos comandos (escolhidas clicando nas linhas); vazio = todas as online e não pausadas. */
  const [targets, setTargets] = useState<string[]>([]);
  const targetIds = targets.length ? targets : null;
  const run = (cmd: CrowdCommand) => p.onCommand(targetIds, cmd);
  const toggleTarget = (id: string) => setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const [view, setView] = useState<'accounts' | 'proxies' | 'network' | 'logs'>('accounts');
  const [proxyDraft, setProxyDraft] = useState<Record<string, string>>({});
  const [pool, setPool] = useState('');
  const [newProxy, setNewProxy] = useState('');
  const [solverKey, setSolverKey] = useState('');
  const [hostsDraft, setHostsDraft] = useState<string | null>(null);

  const byId = new Map(p.crowd.sessions.map((s) => [s.id, s]));
  /** Quem usa cada item do pool (nicks), para o seletor e a lista mostrarem. */
  const poolUsers = new Map<string, string[]>();
  for (const a of p.accounts) if (a.proxyId) poolUsers.set(a.proxyId, [...(poolUsers.get(a.proxyId) ?? []), a.username]);
  const poolSorted = sortPool(p.proxies);
  const trafficById = new Map(p.traffic.map((t) => [t.accountId, t]));
  const headlessCount = p.crowd.sessions.filter((s) => s.transport === 'headless').length;
  const online = p.crowd.sessions.filter((s) => s.status === 'online').length;
  const connected = p.crowd.connectedIds.length;
  const queued = p.crowd.queuedIds;
  const connectedSessions = p.crowd.sessions.filter((s) => p.crowd.connectedIds.includes(s.id));
  /**
   * A coluna "Tela" só ocupa espaço quando há uma página para ver: conta com tela, ou conta sem tela ainda no
   * login/captcha (a página existe até autenticar). Com tudo sem tela e online, ela recolhe a uma faixa e as
   * colunas de trabalho ganham a largura toda.
   */
  const needsScreen = connectedSessions.some((s) => !(s.transport === 'headless' && s.status === 'online'));
  const seated = p.crowd.sessions.filter((s) => s.posture === 'sit').length;
  const lying = p.crowd.sessions.filter((s) => s.posture === 'lay').length;
  const searching = p.crowd.sessions.filter((s) => s.postureTask).length;
  const tilesVisible = p.showTiles && (connected === 0 ? p.network.mode === 'webview' : needsScreen);

  const add = async () => {
    if (!user.trim() || !pass) { p.showToast('Informe usuário e senha'); return; }
    setAdding(true);
    try {
      await p.onAddAccount(user.trim(), pass, label.trim(), newProxy.trim());
      setUser(''); setPass(''); setLabel(''); setNewProxy('');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-x-auto text-[12px]">
      <div className="grid h-full min-w-[820px]" style={{ gridTemplateColumns: tilesVisible ? `${COL_ACCOUNTS} ${COL_COMMANDS} minmax(360px, 1.3fr)` : `${COL_ACCOUNTS} ${COL_COMMANDS} 44px` }}>
        {/* Coluna 1: contas / proxies / log */}
        <div className="flex min-h-0 min-w-0 flex-col border-r border-line">
          <Toolbar className="border-b border-line px-3 py-2">
            <SegmentedTabs value={view} onChange={setView} items={[{ value: 'accounts', label: 'Contas' }, { value: 'proxies', label: <>Proxies{p.proxies.length > 0 && <span className="tnum ml-1 font-mono text-[10px] text-dim">{p.proxies.length}</span>}</> }, { value: 'network', label: 'Rede' }, { value: 'logs', label: 'Log' }]} />
            <span className="min-w-0 truncate text-[11px] text-dim" title={`${online} online · ${p.crowd.sessions.length} de ${p.accounts.length} conectadas${headlessCount ? ` · ${headlessCount} sem tela` : ''}`}>
              <span className="tnum text-accent">{online}</span> online · <span className="tnum">{p.crowd.sessions.length}</span>/<span className="tnum">{p.accounts.length}</span> conectadas
              {headlessCount > 0 && <> · <span className="tnum text-info">{headlessCount}</span> sem tela</>}
              {queued.length > 0 && <> · <span className="tnum text-warn">{queued.length}</span> na fila</>}
            </span>
            <Button
              size="sm"
              active={p.network.mode === 'headless'}
              onClick={() => void p.onSetNetwork({ mode: p.network.mode === 'headless' ? 'webview' : 'headless' })}
              title={p.network.mode === 'headless' ? 'Modo sem tela: a página do jogo só faz o login; depois é só protocolo pelo proxy. Clique para voltar ao modo com tela.' : 'Modo com tela: o cliente Nitro completo roda em cada conta. Clique para ativar o modo sem tela.'}
              className="uppercase tracking-wider"
            >{p.network.mode === 'headless' ? 'sem tela' : 'com tela'}</Button>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <Button variant="primary" onClick={p.onConnectAll} disabled={p.accounts.length === 0}>Conectar todas</Button>
              <Button onClick={p.onDisconnectAll} disabled={p.crowd.sessions.length === 0 && queued.length === 0}>{queued.length > 0 ? 'Cancelar e desconectar' : 'Desconectar'}</Button>
            </div>
          </Toolbar>

          {view === 'accounts' ? (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {p.accounts.length === 0 ? (
                  <EmptyState>Nenhuma conta ainda. Cadastre abaixo: a senha fica criptografada pelo sistema (DPAPI) e cada conta joga numa sessão isolada.</EmptyState>
                ) : (
                  <ul>
                    {p.accounts.map((a) => {
                      const s = byId.get(a.id);
                      const st = s ? STATUS[s.status] : STATUS.offline;
                      const proxyText = a.proxy ?? (p.tor.enabled ? 'via Tor' : 'sem proxy (IP real)');
                      const queuePos = queued.indexOf(a.id);
                      // Opção "fora do pool": o que a conta tem sem o pool (proxy próprio digitado, Tor ou IP real).
                      const noPoolText = a.hasOwnProxy ? `proxy próprio${a.proxyId ? '' : `: ${a.proxy}`}` : p.tor.enabled ? 'via Tor' : 'sem proxy (IP real)';
                      const chosen = a.proxyId ? p.proxies.find((x) => x.id === a.proxyId) : undefined;
                      const selected = targets.includes(a.id);
                      return (
                        <li
                          key={a.id}
                          onClick={() => { if (s) toggleTarget(a.id); }}
                          aria-selected={selected || undefined}
                          title={s ? (selected ? 'Alvo dos comandos (clique para tirar)' : 'Clique para escolher esta conta como alvo dos comandos') : undefined}
                          className={cx('grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 border-b border-line/60 px-3 py-2 transition-colors', s && 'cursor-pointer', selected ? 'bg-accent/[0.07]' : 'odd:bg-bg/30 hover:bg-fg/[0.03]')}
                        >
                          <span className="relative mt-0.5">
                            <Avatar name={a.username} figure={s?.figure} size={30} ring dim={!s || s.status === 'offline' || s.status === 'error'} title={s?.figure ? 'foto pelo visual da conta (2725)' : 'foto pelo nick (imager do fansite)'} />
                            {selected && <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-accent-ink" aria-hidden>✓</span>}
                          </span>
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <StatusPill tone={st.tone} solid={st.solid}>{st.label}</StatusPill>
                              <span className="min-w-0 truncate font-medium text-fg" title={a.username}>{a.username}</span>
                              {a.label && <span className="min-w-0 truncate text-dim">· {a.label}</span>}
                              {s?.pos && s.status === 'online' && <span className="tnum shrink-0 text-[10px] text-dim">({s.pos.x},{s.pos.y})</span>}
                            </div>
                            {s && (s.paused || s.transport === 'headless' || s.follow || s.exitIp || s.posture || s.postureTask) && (
                              <div className="mt-1 flex flex-wrap items-center gap-1">
                                {s.paused && <Chip>pausada</Chip>}
                                {s.transport === 'headless' && <Chip tone="info" title={`WebSocket do jogo: ${fmtBytes(s.bytesIn)} recebidos · ${fmtBytes(s.bytesOut)} enviados`}>sem tela · {fmtBytes(s.bytesIn + s.bytesOut)}</Chip>}
                                {s.follow && <Chip tone="violet" title={s.followStatus}>{s.follow.mode === 'pin' ? 'fixada em' : 'indo até'} {s.follow.target}</Chip>}
                                {s.postureTask && <Chip tone="warn" title={s.postureStatus}>{s.postureTask === 'sit' ? 'procurando lugar para sentar' : 'procurando lugar para deitar'}</Chip>}
                                {s.posture && !s.postureTask && <Chip tone="success">{s.posture === 'sit' ? 'sentada' : 'deitada'}</Chip>}
                                {s.exitIp && <Chip tone="accent" mono title="IP de saída pelo proxy">{s.exitIp}</Chip>}
                              </div>
                            )}
                            <div className="mt-1 truncate text-[11px] text-dim">
                              {s ? (s.status === 'online'
                                ? `${s.roomId !== null ? `${cleanName(s.roomName) || '#' + s.roomId} · ${s.roomUsers} na sala` : 'fora de quarto'} · ${s.sent} pedidos${s.pendingRequests ? ` · ${s.pendingRequests} pendentes` : ''}`
                                : s.detail) : queuePos >= 0 ? `na fila de conexão (${queuePos + 1}ª de ${queued.length})` : 'desconectada'}
                            </div>
                            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px]" onClick={(e) => e.stopPropagation()}>
                              {p.proxies.length > 0 ? (
                                <Select
                                  size="sm"
                                  mono
                                  value={a.proxyId ?? ''}
                                  onChange={(e) => void p.onAssignProxy(a.id, e.target.value || null)}
                                  className={cx('min-w-0 flex-1', chosen?.status === 'blocked' && 'border-danger/60 text-danger')}
                                  title={s ? `Proxy com que a conta vai conectar da próxima vez (agora: ${proxyText}). Mudar exige reconectar.` : `Proxy com que a conta vai conectar: ${proxyText}`}
                                >
                                  <option value="">{noPoolText}</option>
                                  {poolSorted.map((x) => (
                                    <option key={x.id} value={x.id}>{poolOptionText(x, (poolUsers.get(x.id) ?? []).filter((u) => u !== a.username))}</option>
                                  ))}
                                </Select>
                              ) : (
                                <span className={cx('min-w-0 truncate', a.proxy ? 'text-fg-2' : p.tor.enabled ? 'text-info' : 'text-warn')} title={proxyText}>{proxyText}</span>
                              )}
                              {s && s.status !== 'offline' && (
                                <button type="button" onClick={() => void p.onTestProxy(a.id)} className="shrink-0 whitespace-nowrap rounded px-1 text-[10px] text-muted hover:text-accent" title="Descobrir o IP de saída desta conta">testar IP</button>
                              )}
                            </div>
                          </div>
                          <div className="flex items-start gap-1 pt-px" onClick={(e) => e.stopPropagation()}>
                            <Button
                              size="sm"
                              active={a.autoConnect}
                              onClick={() => void p.onSetAutoConnect(a.id, !a.autoConnect)}
                              title={a.autoConnect ? 'Conecta sozinha ao abrir o app (clique para desligar)' : 'Conectar automaticamente ao abrir o app'}
                            >auto</Button>
                            {s ? (
                              <>
                                <Button size="sm" onClick={() => p.onPause(a.id, !s.paused)}>{s.paused ? 'retomar' : 'pausar'}</Button>
                                <Button size="sm" onClick={() => p.onDisconnect(a.id)}>sair</Button>
                              </>
                            ) : queuePos >= 0 ? (
                              <Button size="sm" onClick={() => p.onDisconnect(a.id)} title="Tira esta conta da fila de conexão">na fila ×</Button>
                            ) : (
                              <Button size="sm" variant="primary" onClick={() => p.onConnect(a.id)}>conectar</Button>
                            )}
                            <IconButton size="sm" onClick={() => { if (confirm(`Remover a conta ${a.username}?`)) void p.onRemoveAccount(a.id); }} className="hover:text-danger" title="Remover conta">×</IconButton>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <FormRow className="border-t border-line px-3 py-2">
                <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="usuário" className="flex-1 basis-28" />
                <Input value={pass} onChange={(e) => setPass(e.target.value)} type="password" placeholder="senha" className="flex-1 basis-28" />
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="rótulo" className="flex-1 basis-20" />
                <Input value={newProxy} onChange={(e) => setNewProxy(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="proxy (socks5://user:pass@host:porta)" mono className="flex-[2] basis-56" />
                <Button onClick={add} disabled={adding}>Adicionar</Button>
              </FormRow>
            </>
          ) : view === 'proxies' ? (
            <ProxyPoolView
              proxies={p.proxies}
              accounts={p.accounts}
              onAddProxies={p.onAddProxies}
              onRemoveProxy={p.onRemoveProxy}
              onSetProxyStatus={p.onSetProxyStatus}
              onSetProxyLabel={p.onSetProxyLabel}
              onTestPoolProxy={p.onTestPoolProxy}
              onAutoAssignProxies={p.onAutoAssignProxies}
              showToast={p.showToast}
            />
          ) : view === 'network' ? (
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              <Card
                title="Sem tela (protocolo puro)"
                actions={<Switch checked={p.network.mode === 'headless'} onChange={(v) => void p.onSetNetwork({ mode: v ? 'headless' : 'webview' })} />}
                description="A página do jogo só faz o login e entrega o ticket; o app impede o cliente Nitro de conectar, abre o WebSocket do jogo por conta própria (pelo proxy da conta, com SOCKS5 autenticado) e descarta a página. Nada de assets, WebGL ou memória por conta: o consumo vira só protocolo (KB por minuto). O dashboard controla tudo pelos pacotes; a coluna Tela recolhe para essas contas. Se a conexão cair, refaz o login sozinho."
              >
                <SettingRow label="Reconectar sozinho se a conexão cair" control={<Switch checked={p.network.autoReconnect} onChange={(v) => void p.onSetNetwork({ autoReconnect: v })} />} />
              </Card>
              <Card
                title="Fila de conexão"
                description="Em “Conectar todas” e na conexão automática as contas entram em fila: só este número faz login ao mesmo tempo, e a próxima entra quando uma autentica, falha ou cai no captcha (2 s de respiro entre elas). Dez logins simultâneos pelo mesmo provedor derrubavam metade; 2 por vez entram todas. Contas conectadas uma a uma pelo botão da linha não passam pela fila."
              >
                <SettingRow
                  label="Contas fazendo login ao mesmo tempo"
                  hint="1 = uma por vez (mais lento, mais seguro) · até 10"
                  control={<Input mono type="number" min={1} max={10} value={p.network.connectConcurrency} onChange={(e) => { const n = parseInt(e.target.value, 10); if (n >= 1 && n <= 10) void p.onSetNetwork({ connectConcurrency: n }); }} className="w-16" />}
                />
              </Card>
              <Card
                title="Proxy depois do login"
                actions={<Switch checked={p.network.proxyAfterLogin} onChange={(v) => void p.onSetNetwork({ proxyAfterLogin: v })} />}
                description={<>O Habblet barra VPN e proxy no site (login e hotel). Com isto ligado, o site vê o seu IP real e o proxy entra só depois de autenticada, na conexão do jogo (<span className="font-mono">game.habblet.city</span>). <b>Atenção:</b> o servidor registra o IP da conta pelo site, não pela conexão do jogo. Com isto ligado, as contas contam como do seu IP real (limite de 2 por IP por quarto, por exemplo). Para o jogo ver o IP do proxy, o proxy precisa passar no login: use IP residencial e desligue esta opção. Trocar o IP do site depois do login não funciona: o Habblet derruba a sessão (testado em 17/09/2026). "Testar IP" mostra o IP de saída do proxy da conta.</>}
              />
              <Card
                title="Proxy só para o jogo"
                actions={<Switch checked={p.network.proxyScope === 'game-only'} onChange={(v) => void p.onSetNetwork({ proxyScope: v ? 'game-only' : 'all' })} />}
                description="Só os hosts abaixo (e subdomínios) saem pelo proxy; imagens, mobis e o resto do cliente vão direto pelo seu IP. É o que corta o consumo no modo com tela e durante o login. Um host por linha; aplicado ao reconectar."
              >
                <TextArea
                  mono
                  value={hostsDraft ?? p.network.gameHosts.join('\n')}
                  onChange={(e) => setHostsDraft(e.target.value)}
                  onBlur={() => {
                    if (hostsDraft === null) return;
                    const hosts = hostsDraft.split(/\r?\n/).map((h) => h.trim()).filter(Boolean);
                    setHostsDraft(null);
                    if (hosts.length && hosts.join('\n') !== p.network.gameHosts.join('\n')) void p.onSetNetwork({ gameHosts: hosts });
                  }}
                  rows={3}
                />
              </Card>
              <Card
                title="Tráfego (aprox.)"
                actions={<Button size="sm" onClick={() => void p.onResetTraffic()}>zerar</Button>}
                description="Respostas HTTP por host (pelo content-length, sem cache) desde a abertura do app, e bytes do WebSocket no modo sem tela. Serve para ver para onde vai o plano do proxy."
              >
                {p.traffic.length === 0 ? <p className="text-[11px] text-dim">Sem dados ainda.</p> : (
                  <ul className="space-y-1.5">
                    {p.accounts.map((a) => {
                      const t = trafficById.get(a.id);
                      if (!t) return null;
                      const top = t.hosts.slice(0, 3);
                      return (
                        <li key={a.id} className="rounded-md bg-bg/50 px-2 py-1.5">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
                            <span className="w-28 truncate font-medium text-fg-2">{a.username}</span>
                            <span className="whitespace-nowrap text-warn">proxy <span className="tnum">{fmtBytes(t.bytesViaProxy)}</span></span>
                            <span className="whitespace-nowrap text-dim">direto <span className="tnum">{fmtBytes(t.bytesDirect)}</span></span>
                            {t.headless && <span className="whitespace-nowrap text-info">ws <span className="tnum">{fmtBytes(t.headless.bytesIn + t.headless.bytesOut)}</span></span>}
                            <span className="whitespace-nowrap text-dim"><span className="tnum">{t.requests}</span> req</span>
                            {!t.metered && (
                              <span className="text-dim" title="Com usuário e senha no proxy a medição HTTP fica desligada: um listener de webRequest faz o Electron 35 derrubar o app quando o proxy responde 407 ao WebSocket do jogo. O WebSocket do modo sem tela continua medido.">
                                HTTP sem medição (proxy com senha)
                              </span>
                            )}
                          </div>
                          {top.length > 0 && (
                            <div className="mt-0.5 truncate font-mono text-[10px] text-dim">
                              {top.map((h) => `${h.host} ${fmtBytes(h.bytes)}${h.viaProxy ? ' (proxy)' : ''}`).join(' · ')}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
              <Card
                title="Proxy por conta"
                description={<>Proxy próprio, digitado direto na conta (sem passar pelo pool). Todo o tráfego da conta (site e WebSocket do jogo) sai por ele. Formatos: <span className="font-mono">socks5://user:pass@host:porta</span>, <span className="font-mono">http://host:porta</span>. Vazio = IP real. Aplicado ao conectar; mudar exige reconectar. Se a conta tem um item do pool escolhido, o pool tem prioridade. Em residencial rotativo (Bright Data, Decodo, Oxylabs, IPRoyal) o app acrescenta sozinho uma sessão fixa por conta no usuário do proxy, para login, hotel e jogo saírem pelo mesmo IP.</>}
              >
                <ul className="space-y-1.5">
                  {p.accounts.map((a) => (
                    <li key={a.id} className="flex items-center gap-1.5">
                      <span className="w-28 shrink-0 truncate text-fg-2" title={a.username}>{a.username}</span>
                      <Input
                        mono
                        value={proxyDraft[a.id] ?? ''}
                        onChange={(e) => setProxyDraft((d) => ({ ...d, [a.id]: e.target.value }))}
                        placeholder={a.proxyId ? `usando o pool (${a.proxy ?? '?'})` : a.proxy ?? 'sem proxy'}
                        className="flex-1"
                      />
                      <Button onClick={() => { void p.onSetProxy(a.id, proxyDraft[a.id] ?? ''); setProxyDraft((d) => ({ ...d, [a.id]: '' })); }}>Salvar</Button>
                      {a.hasOwnProxy && <IconButton onClick={() => void p.onSetProxy(a.id, '')} className="hover:text-danger" title="Remover o proxy próprio">×</IconButton>}
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title="Distribuir em lote" description="Cole um proxy por linha; o 1.º vai para a 1.ª conta, o 2.º para a 2.ª… Contas a mais ficam como estão.">
                <TextArea mono value={pool} onChange={(e) => setPool(e.target.value)} rows={5} placeholder={'socks5://user:pass@1.2.3.4:1080\nhttp://5.6.7.8:8080'} />
                <div className="mt-2 flex justify-end">
                  <Button variant="primary" onClick={() => { const list = pool.split(/\r?\n/).map((l) => l.trim()).filter(Boolean); if (list.length) { void p.onDistributeProxies(list); setPool(''); } }}>Distribuir</Button>
                </div>
              </Card>
              <Card
                title="Tor (IP grátis por conta)"
                actions={<Switch checked={p.tor.enabled} onChange={(v) => void p.onSetTor({ enabled: v })} />}
                description="Dá a cada conta sem proxy um IP de saída diferente, de graça, abrindo uma porta SOCKS por conta no Tor. O Cloudflare marca saída Tor, então toda conta cai no captcha (use o resolvedor abaixo) e a conexão fica lenta; serve para teste. Instale o Tor, gere o torrc, inicie o Tor e conecte as contas."
              >
                <FormRow>
                  <label className="text-[11px] text-dim">porta base</label>
                  <Input mono type="number" value={p.tor.basePort} onChange={(e) => void p.onSetTor({ basePort: parseInt(e.target.value, 10) || 9050 })} className="w-20" />
                  <label className="text-[11px] text-dim">portas</label>
                  <Input mono type="number" value={p.tor.count} onChange={(e) => void p.onSetTor({ count: parseInt(e.target.value, 10) || 20 })} className="w-16" />
                </FormRow>
                <Input mono value={p.tor.torExePath ?? ''} onChange={(e) => void p.onSetTor({ torExePath: e.target.value || null })} placeholder={p.torStatus.torExe ? `detectado: ${p.torStatus.torExe}` : 'caminho do tor.exe (não encontrado — informe aqui)'} className="mt-1.5 w-full" />
                <Toolbar className="mt-2">
                  <Button onClick={() => void p.onGenerateTorrc()}>Gerar torrc</Button>
                  {p.torStatus.running
                    ? <Button variant="danger" onClick={() => void p.onStopTor()}>Parar Tor</Button>
                    : <Button variant="primary" onClick={() => void p.onLaunchTor()}>Iniciar Tor</Button>}
                  <span className={cx('min-w-0 truncate text-[11px]', p.torStatus.running ? 'text-accent' : p.torStatus.error ? 'text-danger' : 'text-dim')}>{p.torStatus.running ? 'rodando' : p.torStatus.error ? p.torStatus.error : p.torStatus.torExe ? 'parado (tor.exe encontrado)' : 'parado (tor.exe não encontrado)'}</span>
                </Toolbar>
                <p className="mt-1.5 text-[11px] leading-relaxed text-dim">O Tor roda sem janela. Depois de "Iniciar Tor" (status <span className="text-accent">rodando</span>), o Tor leva ~10–30 s para montar os circuitos; então conecte as contas e use <b>testar IP</b> em cada uma para ver o IP de saída (será diferente por conta). Não use o botão do Tor Browser; o app sobe o Tor próprio nas portas {p.tor.basePort}–{p.tor.basePort + p.tor.count - 1}.</p>
              </Card>
              <Card
                title="Captcha automático"
                description={<>Quando o Cloudflare pede interação (página "Confirme que é humano" ou o Turnstile do login), o app pede o token a um serviço com a sua chave e segue o login sozinho. O 2Captcha resolve os dois casos; o CapSolver só o widget do login. Sem serviço, a conta fica em <b className="text-warn">captcha</b> e você clica na tela. A chave fica criptografada.</>}
              >
                <FormRow>
                  <Select value={p.solver.provider} onChange={(e) => void p.onSetSolver(e.target.value as CaptchaSolverProvider, null)}>
                    <option value="none">Desligado (manual)</option>
                    <option value="2captcha">2Captcha</option>
                    <option value="capsolver">CapSolver</option>
                  </Select>
                  <Input mono value={solverKey} onChange={(e) => setSolverKey(e.target.value)} type="password" placeholder={p.solver.hasKey ? 'chave guardada · cole outra para trocar' : 'chave da API'} className="flex-1 basis-40" />
                  <Button onClick={() => { if (solverKey.trim()) { void p.onSetSolver(p.solver.provider === 'none' ? '2captcha' : p.solver.provider, solverKey.trim()); setSolverKey(''); } }}>Salvar chave</Button>
                </FormRow>
              </Card>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px]">
              {p.crowd.logs.length === 0 ? <EmptyState>Sem eventos ainda.</EmptyState> : (
                <div className="px-2 py-1">
                  {p.crowd.logs.slice(-300).reverse().map((l, i) => (
                    <div key={i} className="flex gap-2 rounded px-1 py-0.5 hover:bg-raised/60">
                      <span className="tnum shrink-0 text-dim">{new Date(l.t).toLocaleTimeString('pt-BR', { hour12: false })}</span>
                      <span className="shrink-0 text-violet">{l.username}</span>
                      <span className="min-w-0 break-words text-fg-2">{l.msg}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Coluna 2: alvo, barra de comando e addons */}
        <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto border-r border-line p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Eyebrow>Alvo</Eyebrow>
            <Button size="sm" active={targets.length === 0} onClick={() => setTargets([])} title="Todas as contas online e não pausadas">Todas</Button>
            {targets.map((id) => {
              const sess = byId.get(id);
              const name = sess?.account.username ?? p.accounts.find((a) => a.id === id)?.username ?? id;
              return (
                <Button key={id} size="sm" active onClick={() => toggleTarget(id)} title="Tirar do alvo" className="max-w-[160px]">
                  <span className="truncate">{name}</span> ×
                </Button>
              );
            })}
            <span className="ml-auto text-[11px] text-dim">{targets.length ? `${targets.length} conta(s)` : `${online} online`} · escolha clicando nas contas</span>
          </div>

          <CommandBar
            serverCommands={p.crowd.commands}
            targetLabel={targets.length ? `${targets.length} conta(s) escolhida(s)` : 'todas as online'}
            onRun={run}
            showToast={p.showToast}
          />

          <div className="text-[11px] text-dim">
            <span className="tnum">{seated}</span> sentada(s) · <span className="tnum">{lying}</span> deitada(s){searching ? <> · <span className="tnum">{searching}</span> procurando lugar</> : null}{p.hasFurniCatalog ? '' : ' · sem furnidata: só casas onde alguém já foi visto sentado'}
          </div>

          <Card title="Addons na multidão" description="usam as mesmas configurações dos addons do painel Addons">
            <div className="divide-y divide-line/60">
              {ADDONS.filter((d) => d.engines !== 'dom').map((d) => (
                <SettingRow key={d.id} label={d.name} control={<Switch checked={p.crowd.addonsEnabled[d.id]} onChange={(v) => p.onToggleAddon(d.id, v)} />} />
              ))}
            </div>
          </Card>

          <Card
            title="Memória e tráfego"
            description={p.network.mode === 'headless'
              ? 'Modo sem tela: cada conta é só uma conexão de protocolo depois do login (KB por minuto, sem WebGL). A página do jogo existe apenas durante o login.'
              : 'Modo com tela: cada conta roda o cliente do jogo completo (WebGL) e baixa os mobis de cada quarto. Muitas contas consomem memória e o plano do proxy; ocultar a tela não reduz nada. Ative "sem tela" na aba Proxies.'}
          />
        </div>

        {/* Coluna 3: tela única (a camada de webviews é posicionada sobre o placeholder) ou a faixa recolhida */}
        {tilesVisible ? (
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
              <Eyebrow className="mr-1 shrink-0">Tela</Eyebrow>
              {connectedSessions.map((s) => {
                const active = p.viewId === s.id;
                const st = STATUS[s.status];
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => p.onSelectView(s.id)}
                    className={cx('flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[11px] transition-colors', active ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg')}
                    title={`${s.account.username} · ${st.label}`}
                  >
                    <Dot tone={s.status === 'online' ? 'accent' : s.status === 'captcha' ? 'warn' : s.status === 'error' ? 'danger' : 'neutral'} pulse={s.status === 'captcha'} />
                    {s.account.username}
                  </button>
                );
              })}
              {connected === 0 && <span className="whitespace-nowrap text-[11px] text-dim">nenhuma conta conectada</span>}
              <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
                <span className="text-[11px] text-dim">mostrar</span>
                <Switch checked={p.showTiles} onChange={p.onToggleTiles} title="Mostrar/ocultar a tela" />
              </div>
            </div>
            <div ref={onTilesPlaceholder} className="relative min-h-0 min-w-0 flex-1 bg-bg/40">
              {connected === 0 && <EmptyState>conecte uma conta para ver a tela dela aqui</EmptyState>}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col items-center gap-3 py-2" title={!p.showTiles ? 'Tela oculta' : headlessCount > 0 ? `${headlessCount} conta(s) sem tela: nada a exibir` : 'nenhuma conta com tela'}>
            <Switch checked={p.showTiles} onChange={p.onToggleTiles} title="Mostrar/ocultar a tela" />
            <Eyebrow className="[writing-mode:vertical-rl] rotate-180 select-none">{!p.showTiles ? 'tela oculta' : 'sem tela'}</Eyebrow>
            <div ref={onTilesPlaceholder} className="h-0 w-0 overflow-hidden" />
          </div>
        )}
      </div>
    </div>
  );
}

