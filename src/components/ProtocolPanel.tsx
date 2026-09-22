import { memo, useMemo, useState } from 'react';
import type { ProtocolCaptureApi } from '../protocol/useProtocolCapture';
import type { ProtocolEntry, ProtocolPacket } from '../../shared/protocol';
import { headerLabelKey } from '../../shared/protocol';
import { assembleBody, base64ToBytes, extractStrings, hexDump } from '../protocol/decode';
import { Button, Dot, EmptyState, Eyebrow, IconButton, Input, Select, TextArea, Toolbar } from './ui';
import { cx } from './cx';
import { fmtTimeMs as fmtTime } from './text';

/** Quantas linhas a lista mostra de uma vez (as mais recentes). O buffer completo vai na exportação. */
const VISIBLE_LIMIT = 600;

export interface ProtocolPanelProps {
  capture: ProtocolCaptureApi;
  labels: Record<string, string>;
  onSetLabel: (key: string, label: string) => void;
  showToast: (msg: string) => void;
}

type DirFilter = 'all' | 'in' | 'out';

function entryId(e: ProtocolEntry): string {
  return e.kind === 'packet' ? 'p' + e.packet.id : e.kind === 'socket' ? 's' + e.id : 'm' + e.id;
}

function headerName(p: ProtocolPacket): string {
  if (p.header === -1) return 'bytes sem framing';
  if (p.header === -2) return 'texto';
  return String(p.header);
}

export default function ProtocolPanel({ capture, labels, onSetLabel, showToast }: ProtocolPanelProps) {
  const [dirFilter, setDirFilter] = useState<DirFilter>('all');
  const [headerFilter, setHeaderFilter] = useState('');
  const [textFilter, setTextFilter] = useState('');
  const [hideNoise, setHideNoise] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [markerText, setMarkerText] = useState('');
  const [showSender, setShowSender] = useState(false);
  const [showProbe, setShowProbe] = useState(false);

  const filtered = useMemo(() => {
    const hf = headerFilter.trim();
    const headerSet = new Set(
      hf
        .split(/[,\s]+/)
        .filter(Boolean)
        .map((x) => parseInt(x, 10))
        .filter((n) => !Number.isNaN(n)),
    );
    const tf = textFilter.trim().toLowerCase();
    const out: ProtocolEntry[] = [];
    const all = capture.entries;
    for (let i = all.length - 1; i >= 0 && out.length < VISIBLE_LIMIT; i--) {
      const e = all[i];
      if (e.kind !== 'packet') {
        if (!hf && !tf) out.push(e);
        continue;
      }
      const p = e.packet;
      if (dirFilter !== 'all' && p.dir !== dirFilter) continue;
      if (headerSet.size && !headerSet.has(p.header)) continue;
      if (hideNoise && p.bodyLength <= 4 && !labels[headerLabelKey(p.dir, p.header)]) continue;
      if (tf) {
        const label = (labels[headerLabelKey(p.dir, p.header)] || '').toLowerCase();
        let hit = label.includes(tf) || String(p.header).includes(tf);
        if (!hit) {
          const strings = extractStrings(base64ToBytes(p.body));
          hit = strings.some((s) => s.value.toLowerCase().includes(tf));
        }
        if (!hit) continue;
      }
      out.push(e);
    }
    return out.reverse();
  }, [capture.entries, dirFilter, headerFilter, textFilter, hideNoise, labels]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    const e = capture.entries.find((x) => entryId(x) === selectedId);
    return e && e.kind === 'packet' ? e.packet : null;
  }, [selectedId, capture.entries]);

  const exportJson = () => {
    const data = {
      exportedAt: new Date().toISOString(),
      labels,
      probe: capture.probe,
      sockets: capture.sockets,
      entries: capture.entries,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `habblet-protocolo-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Captura exportada');
  };

  const addMarker = () => {
    const t = markerText.trim() || 'Marcador';
    capture.addMarker(t);
    setMarkerText('');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[11px]">
      <Toolbar className="shrink-0 border-b border-line px-3 py-1.5">
        <span
          className={cx('inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[10px] font-medium', capture.agentReady ? 'bg-success/15 text-success' : 'bg-raised text-muted')}
          title={capture.agentReady ? 'Agente injetado e interceptando o WebSocket' : 'Aguardando a página carregar o agente'}
        >
          <Dot tone={capture.agentReady ? 'success' : 'neutral'} pulse={capture.agentReady} />
          {capture.agentReady ? 'Agente ativo' : 'Agente inativo'}
        </span>
        <span className="tnum whitespace-nowrap text-dim">
          <span className="text-info">↓ {capture.totalIn}</span> · <span className="text-warn">↑ {capture.totalOut}</span>
        </span>
        <div className="h-4 w-px bg-line" />
        <Select value={dirFilter} onChange={(e) => setDirFilter(e.target.value as DirFilter)}>
          <option value="all">Entrada e saída</option>
          <option value="in">↓ Só entrada</option>
          <option value="out">↑ Só saída</option>
        </Select>
        <Input mono value={headerFilter} onChange={(e) => setHeaderFilter(e.target.value)} placeholder="headers (ex.: 1234, 56)" className="w-40" />
        <Input value={textFilter} onChange={(e) => setTextFilter(e.target.value)} placeholder="texto / rótulo" className="w-36" />
        <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted">
          <input type="checkbox" checked={hideNoise} onChange={(e) => setHideNoise(e.target.checked)} className="accent-accent" /> ocultar pacotes ≤ 4 bytes sem rótulo
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Input value={markerText} onChange={(e) => setMarkerText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addMarker()} placeholder="marcador (ex.: cliquei em Pedir Amizade)" className="w-64" />
          <Button onClick={addMarker} title="Insere uma linha na captura para marcar o momento de uma ação sua">Marcar</Button>
          <Button variant={capture.paused ? 'danger' : 'secondary'} onClick={() => capture.setPaused(!capture.paused)}>{capture.paused ? 'Retomar' : 'Pausar'}</Button>
          <Button onClick={() => { capture.clear(); setSelectedId(null); }}>Limpar</Button>
          <Button onClick={exportJson}>Exportar</Button>
          <Button active={showProbe} onClick={() => { setShowProbe((v) => !v); capture.requestProbe(); }} title="O que o cliente expõe (globais, URL do socket, NitroConfig)">Internos</Button>
          <Button active={showSender} onClick={() => setShowSender((v) => !v)}>Enviar pacote</Button>
        </div>
      </Toolbar>

      {capture.lastError && (
        <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-1 text-danger">{capture.lastError}</div>
      )}

      {showProbe && <ProbeView capture={capture} />}
      {showSender && <PacketSender capture={capture} showToast={showToast} />}

      {/* Lista + detalhe */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto font-mono">
          {filtered.length === 0 ? (
            <EmptyState>
              {capture.entries.length === 0
                ? 'Nenhum pacote ainda. Carregue o jogo: o agente intercepta o WebSocket assim que o cliente conecta.'
                : 'Nada corresponde ao filtro.'}
            </EmptyState>
          ) : (
            <table className="w-full border-collapse">
              <tbody>
                {filtered.map((e) => (
                  <EntryRow key={entryId(e)} entry={e} labels={labels} selected={entryId(e) === selectedId} onSelect={() => setSelectedId(entryId(e) === selectedId ? null : entryId(e))} />
                ))}
              </tbody>
            </table>
          )}
        </div>
        {selected && (
          <PacketDetail
            packet={selected}
            label={labels[headerLabelKey(selected.dir, selected.header)] || ''}
            onSetLabel={(l) => onSetLabel(headerLabelKey(selected.dir, selected.header), l)}
            onReplay={() => {
              if (capture.replay(selected)) showToast('Pacote reenviado');
              else showToast('Não dá para reenviar: corpo truncado ou sem framing');
            }}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
      <div className="tnum shrink-0 border-t border-line px-3 py-1 text-[10px] text-dim">
        Mostrando {filtered.length} de {capture.entries.length} entradas em memória (máx. {VISIBLE_LIMIT} na lista; a exportação leva tudo).
      </div>
    </div>
  );
}

const EntryRow = memo(function EntryRow({ entry, labels, selected, onSelect }: { entry: ProtocolEntry; labels: Record<string, string>; selected: boolean; onSelect: () => void }) {
  if (entry.kind === 'marker') {
    return (
      <tr className="bg-accent/10 text-violet">
        <td className="tnum whitespace-nowrap px-2 py-0.5 text-dim">{fmtTime(entry.t)}</td>
        <td colSpan={5} className="px-2 py-0.5">▸ {entry.text}</td>
      </tr>
    );
  }
  if (entry.kind === 'socket') {
    const ev = entry.event;
    const color = ev.event === 'open' ? 'text-success' : ev.event === 'close' || ev.event === 'error' ? 'text-danger' : 'text-muted';
    return (
      <tr className="bg-bg/60">
        <td className="tnum whitespace-nowrap px-2 py-0.5 text-dim">{fmtTime(ev.t)}</td>
        <td colSpan={5} className={cx('px-2 py-0.5', color)}>
          ● socket #{ev.socketId} {ev.event}
          {ev.url ? ' ' + ev.url : ''}
          {ev.code !== undefined ? ` (code ${ev.code}${ev.reason ? ', ' + ev.reason : ''})` : ''}
        </td>
      </tr>
    );
  }
  const p = entry.packet;
  const label = labels[headerLabelKey(p.dir, p.header)];
  const dirColor = p.dir === 'in' ? 'text-info' : 'text-warn';
  const strings = p.bodyLength > 0 && p.bodyLength <= 2048 ? extractStrings(base64ToBytes(p.body)).slice(0, 4) : [];
  return (
    <tr onClick={onSelect} className={cx('cursor-pointer border-b border-line/40', selected ? 'bg-info/15' : 'odd:bg-bg/40 hover:bg-raised')}>
      <td className="tnum whitespace-nowrap px-2 py-0.5 text-dim">{fmtTime(p.t)}</td>
      <td className={cx('px-2 py-0.5 font-semibold', dirColor)}>{p.dir === 'in' ? '↓' : '↑'}{p.injected ? '*' : ''}</td>
      <td className="tnum whitespace-nowrap px-2 py-0.5 text-fg">{headerName(p)}</td>
      <td className="max-w-[180px] truncate px-2 py-0.5 text-violet">{label || ''}</td>
      <td className="tnum whitespace-nowrap px-2 py-0.5 text-dim">{p.bodyLength} B{p.truncated ? ' (cortado)' : ''}{p.redacted ? ' (oculto)' : ''}</td>
      <td className="max-w-[420px] truncate px-2 py-0.5 text-fg-2">{strings.map((s) => `"${s.value}"`).join('  ')}</td>
    </tr>
  );
});

function PacketDetail({ packet, label, onSetLabel, onReplay, onClose }: { packet: ProtocolPacket; label: string; onSetLabel: (l: string) => void; onReplay: () => void; onClose: () => void }) {
  const bytes = useMemo(() => base64ToBytes(packet.body), [packet.body]);
  const dump = useMemo(() => hexDump(bytes), [bytes]);
  const strings = useMemo(() => extractStrings(bytes), [bytes]);
  const [draft, setDraft] = useState(label);
  const key = headerLabelKey(packet.dir, packet.header);

  return (
    <div className="flex w-[440px] shrink-0 flex-col border-l border-line bg-bg/60">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className={cx('shrink-0 font-semibold', packet.dir === 'in' ? 'text-info' : 'text-warn')}>{packet.dir === 'in' ? '↓ entrada' : '↑ saída'}</span>
        <span className="tnum shrink-0 text-fg">header {headerName(packet)}</span>
        <span className="tnum min-w-0 truncate text-dim">{packet.bodyLength} bytes · {fmtTime(packet.t)}</span>
        <IconButton size="sm" onClick={onClose} className="ml-auto" title="Fechar">✕</IconButton>
      </div>
      <Toolbar className="border-b border-line px-3 py-1.5">
        <Input
          key={key}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSetLabel(draft.trim())}
          placeholder={`rótulo para ${key} (ex.: Pedir amizade)`}
          className="flex-1 basis-40"
        />
        <Button variant="primary" onClick={() => onSetLabel(draft.trim())}>Rotular</Button>
        {packet.dir === 'out' && (
          <Button variant="danger" onClick={onReplay} title="Envia este mesmo pacote de novo para o servidor">Reenviar</Button>
        )}
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono">
        {strings.length > 0 && (
          <div className="mb-3">
            <Eyebrow className="mb-1 block">Strings encontradas</Eyebrow>
            <ul className="space-y-0.5">
              {strings.map((s) => (
                <li key={s.offset} className="text-fg-2"><span className="text-dim">@{s.offset.toString(16).padStart(4, '0')}</span> "{s.value}"</li>
              ))}
            </ul>
          </div>
        )}
        <Eyebrow className="mb-1 block">Hex</Eyebrow>
        {dump.length === 0 ? (
          <div className="text-dim">(corpo vazio)</div>
        ) : (
          <pre className="whitespace-pre text-[10.5px] leading-4 text-fg-2">
            {dump.map((l) => `${l.offset}  ${l.hex}  |${l.ascii}|`).join('\n')}
            {packet.truncated ? '\n… (cortado em 256 KB)' : ''}
          </pre>
        )}
      </div>
    </div>
  );
}

function ProbeView({ capture }: { capture: ProtocolCaptureApi }) {
  const p = capture.probe;
  return (
    <div className="shrink-0 border-b border-line bg-bg/60 px-3 py-2 font-mono text-fg-2">
      {!p ? (
        <span className="text-muted">Sondando… (o agente responde assim que a página estiver carregada)</span>
      ) : (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          <span className="text-dim">página</span><span className="truncate">{p.href}</span>
          <span className="text-dim">socket</span><span className="truncate">{p.socketUrl || '—'} <span className="text-dim">({p.openSockets} aberta(s))</span></span>
          <span className="text-dim">globais</span>
          <span className="break-words">{Object.keys(p.found).length === 0 ? <span className="text-warn">nenhum global conhecido exposto (cliente empacotado)</span> : Object.entries(p.found).map(([k, v]) => `${k}: ${v}`).join('  ·  ')}</span>
          {p.nitroConfigKeys && (
            <>
              <span className="text-dim">NitroConfig</span>
              <span className="break-words text-muted">{p.nitroConfigKeys.join(', ')}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PacketSender({ capture, showToast }: { capture: ProtocolCaptureApi; showToast: (m: string) => void }) {
  const [header, setHeader] = useState('');
  const [spec, setSpec] = useState('');
  const [error, setError] = useState<string | null>(null);

  const send = () => {
    const h = parseInt(header, 10);
    if (Number.isNaN(h)) { setError('Informe o header (número).'); return; }
    try {
      const body = assembleBody(spec);
      capture.sendPacket(h, body);
      setError(null);
      showToast(`Pacote ${h} enviado (${body.length} bytes)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="shrink-0 border-b border-line bg-bg/60 px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="flex flex-col gap-1">
          <Eyebrow>Header</Eyebrow>
          <Input mono value={header} onChange={(e) => setHeader(e.target.value)} placeholder="ex.: 1234" className="w-24" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Eyebrow>Corpo (um campo por linha: i int32 · s int16 · b byte · t string · x hex)</Eyebrow>
          <TextArea mono value={spec} onChange={(e) => setSpec(e.target.value)} rows={3} placeholder={'t NomeDoUsuario\ni 0'} />
        </div>
        <Button variant="primary" className="mt-5" onClick={send} disabled={!capture.agentReady} title={capture.agentReady ? 'Envia pela conexão ativa do jogo' : 'Agente inativo'}>Enviar</Button>
      </div>
      {error && <div className="mt-1 text-danger">{error}</div>}
    </div>
  );
}
