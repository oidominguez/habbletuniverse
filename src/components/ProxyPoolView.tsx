import { useState } from 'react';
import type { CrowdAccount, ProxyPoolEntry, ProxyPoolStatus, ProxyTestResult } from '../../shared/crowd';
import { Avatar } from './Avatar';
import { Button, EmptyState, Eyebrow, IconButton, Input, SegmentedTabs, StatusPill, TextArea } from './ui';
import { POOL_STATUS, sortPool } from './proxyPoolUi';
import { cx } from './cx';

export interface ProxyPoolViewProps {
  proxies: ProxyPoolEntry[];
  accounts: CrowdAccount[];
  onAddProxies: (text: string) => Promise<void>;
  onRemoveProxy: (id: string) => Promise<void>;
  onSetProxyStatus: (id: string, status: ProxyPoolStatus, note?: string) => Promise<void>;
  onSetProxyLabel: (id: string, label: string) => Promise<void>;
  onTestPoolProxy: (id: string) => Promise<ProxyTestResult>;
  onAutoAssignProxies: () => Promise<void>;
  showToast: (m: string) => void;
}

type Filter = 'all' | 'free' | 'used' | 'blocked';

/**
 * Aba Proxies da Multidão: o pool em tabela (status, rótulo, host, IP de saída, quem usa, ações) com filtros,
 * e a coluna para colar a lista. Cada conta escolhe um item no seletor da linha dela, na aba Contas; o
 * status vem do uso (online = ok, login recusado = anti-VPN, falha ao sair = erro).
 */
export default function ProxyPoolView(p: ProxyPoolViewProps) {
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [labelDraft, setLabelDraft] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('all');

  const users = new Map<string, string[]>();
  for (const a of p.accounts) if (a.proxyId) users.set(a.proxyId, [...(users.get(a.proxyId) ?? []), a.username]);
  const sorted = sortPool(p.proxies);
  const counts = p.proxies.reduce((acc, x) => { acc[x.status]++; return acc; }, { ok: 0, unknown: 0, error: 0, blocked: 0 } as Record<ProxyPoolStatus, number>);
  const isFree = (x: ProxyPoolEntry) => x.status !== 'blocked' && x.status !== 'error' && !users.has(x.id);
  const free = p.proxies.filter(isFree).length;
  const visible = sorted.filter((x) => filter === 'all' ? true : filter === 'free' ? isFree(x) : filter === 'used' ? users.has(x.id) : x.status === 'blocked');

  const add = async () => {
    if (!text.trim()) { p.showToast('Cole um proxy por linha'); return; }
    setAdding(true);
    try {
      await p.onAddProxies(text);
      setText('');
    } finally {
      setAdding(false);
    }
  };
  const test = async (id: string) => {
    setTesting((s) => new Set(s).add(id));
    try { await p.onTestPoolProxy(id); } finally { setTesting((s) => { const n = new Set(s); n.delete(id); return n; }); }
  };
  /** Testa em sequência os que ainda não têm IP (um por vez, para não estourar o provedor). */
  const testUntested = async () => {
    const list = sorted.filter((x) => !x.lastIp && x.status !== 'blocked');
    if (list.length === 0) { p.showToast('Todos os proxies do pool já têm IP de saída'); return; }
    for (const x of list) await test(x.id);
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-h-0 flex-col border-r border-line">
        <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
          <Eyebrow>Pool</Eyebrow>
          <span className="text-[12px] text-dim">
            <span className="tnum font-mono">{p.proxies.length}</span> proxies · <span className="tnum font-mono text-accent">{counts.ok}</span> ok · <span className="tnum font-mono">{counts.unknown}</span> não testados · <span className="tnum font-mono text-warn">{counts.error}</span> erro · <span className="tnum font-mono text-danger">{counts.blocked}</span> anti-VPN
          </span>
          <span className="flex-1" />
          <SegmentedTabs value={filter} onChange={setFilter} items={[{ value: 'all', label: 'todos' }, { value: 'free', label: `livres ${free}` }, { value: 'used', label: 'em uso' }, { value: 'blocked', label: 'anti-VPN' }]} />
          <Button size="sm" onClick={() => void testUntested()} disabled={testing.size > 0 || p.proxies.length === 0} title="Descobre o IP de saída dos que ainda não têm, um por vez. Só prova que o proxy responde; se o site barra (anti-VPN) só o login diz, e aí o item fica marcado sozinho.">Testar novos</Button>
          <Button size="sm" variant="primary" onClick={() => void p.onAutoAssignProxies()} disabled={free === 0} title="Cada conta sem proxy recebe um proxy livre do pool (nem bloqueado, nem com erro, nem em uso por outra conta).">Distribuir livres ({free})</Button>
        </div>
        {p.proxies.length === 0 ? (
          <EmptyState>Nenhum proxy no pool ainda. Cole a lista ao lado, um por linha: cada conta escolhe o seu no seletor da linha dela, na aba Contas.</EmptyState>
        ) : (
          <>
            <div className="grid h-8 shrink-0 grid-cols-[88px_112px_minmax(0,1fr)_128px_150px_auto] items-center gap-3 px-4">
              <Eyebrow>Status</Eyebrow><Eyebrow>Rótulo</Eyebrow><Eyebrow>Proxy</Eyebrow><Eyebrow>IP de saída</Eyebrow><Eyebrow>Usado por</Eyebrow><span className="w-[118px]" />
            </div>
            <ul className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-2">
              {visible.length === 0 && <li className="py-6 text-center text-[11.5px] text-dim">nada neste filtro</li>}
              {visible.map((x) => {
                const st = POOL_STATUS[x.status];
                const by = users.get(x.id) ?? [];
                const busy = testing.has(x.id);
                return (
                  <li key={x.id} className="grid h-11 grid-cols-[88px_112px_minmax(0,1fr)_128px_150px_auto] items-center gap-3 rounded-xl px-2 hover:bg-fg/[0.03]">
                    <StatusPill tone={st.tone} solid={x.status === 'blocked'} className="min-w-0">{st.label}</StatusPill>
                    <Input
                      size="sm"
                      value={labelDraft[x.id] ?? x.label}
                      onChange={(e) => setLabelDraft((d) => ({ ...d, [x.id]: e.target.value }))}
                      onBlur={() => {
                        const v = labelDraft[x.id];
                        if (v !== undefined && v.trim() !== x.label) void p.onSetProxyLabel(x.id, v.trim());
                        setLabelDraft((d) => { const n = { ...d }; delete n[x.id]; return n; });
                      }}
                      placeholder="rótulo"
                    />
                    <span className="min-w-0 truncate font-mono text-[12px] text-fg-2" title={`${x.description}${x.note ? `\n${x.note}` : ''}`}>
                      {x.display}
                      {x.note && x.status !== 'ok' && <span className={cx('ml-2 font-sans text-[11px]', x.status === 'blocked' ? 'text-danger' : 'text-warn')}>· {x.note}</span>}
                    </span>
                    <span className={cx('tnum truncate font-mono text-[12px]', x.lastIp ? 'text-accent' : 'text-dim')}>{x.lastIp ?? '—'}</span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      {by.slice(0, 3).map((u) => <Avatar key={u} name={u} size={22} />)}
                      <span className={cx('min-w-0 truncate text-[11.5px]', by.length ? 'text-fg-2' : 'text-dim')} title={by.join(', ')}>{by.length === 0 ? 'livre' : by.length === 1 ? by[0] : `${by.length} contas`}</span>
                    </span>
                    <span className="flex w-[118px] items-center justify-end gap-1">
                      <Button size="sm" onClick={() => void test(x.id)} disabled={busy} title="Sair por este proxy e ver o IP">{busy ? '…' : 'testar'}</Button>
                      {x.status === 'blocked'
                        ? <Button size="sm" onClick={() => void p.onSetProxyStatus(x.id, 'unknown')} title="Volta a 'não testado' para tentar de novo">liberar</Button>
                        : <Button size="sm" onClick={() => void p.onSetProxyStatus(x.id, 'blocked', 'marcado à mão')} title="Marcar como barrado pelo anti-VPN">bloquear</Button>}
                      <IconButton size="sm" onClick={() => { if (by.length === 0 || confirm(`Este proxy está em uso por ${by.join(', ')}. Remover mesmo assim? As contas voltam ao IP real (ou ao proxy próprio).`)) void p.onRemoveProxy(x.id); }} className="hover:text-danger" title="Remover do pool">×</IconButton>
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="flex h-9 shrink-0 items-center border-t border-line px-4 text-[11px] text-dim">o status vem do uso: conta online marca ok, login recusado marca anti-VPN, falha ao sair marca erro · o pool fica criptografado em crowd.json</div>
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
        <Eyebrow>Adicionar ao pool</Eyebrow>
        <TextArea mono value={text} onChange={(e) => setText(e.target.value)} rows={7} placeholder={'um por linha, como o provedor entrega:\nuser:pass@host:porta\nsocks5://user:pass@host:porta\n# linhas com # são ignoradas'} />
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => void add()} disabled={adding || !text.trim()}>Adicionar ao pool</Button>
          <span className="text-[11px] text-dim">repetidos não entram duas vezes</span>
        </div>
        <div className="mt-1 flex flex-col gap-1.5 rounded-2xl border border-line bg-fg/[0.03] p-3.5">
          <span className="text-[12.5px] font-semibold text-fg">Como funciona</span>
          <span className="text-[12px] leading-relaxed text-dim">Cada conta escolhe um proxy do pool no seletor da linha dela, na aba Contas; vale na próxima conexão. Ao conectar, o resultado grava no proxy, então um proxy ruim é visto uma vez só. Sem esquema, a linha vira <span className="font-mono">http://</span>. Em residencial rotativo, o app acrescenta uma sessão fixa por conta no usuário do proxy.</span>
        </div>
      </div>
    </div>
  );
}
