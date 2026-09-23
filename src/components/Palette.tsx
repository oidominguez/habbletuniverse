import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AddonId } from '../../shared/addon-config';
import { ADDONS } from '../addons/registry';
import type { CrowdCommand } from '../crowd/CrowdManager';
import { describeCommand, findSpec, parseCrowdCommand, suggestCommands } from '../crowd/commandParser';
import { cx } from './cx';

export type PaletteTab = 'logs' | 'board' | 'protocol' | 'game' | 'crowd';

export interface PaletteProps {
  onClose: () => void;
  /** Endereço atual, para pré-sugerir. */
  currentUrl: string;
  enabled: Record<AddonId, boolean>;
  /** Comandos de chat anunciados pelo servidor às contas da Multidão (432). */
  serverCommands: readonly string[];
  crowdOnline: number;
  onNavigate: (url: string) => void;
  onReload: () => void;
  onTab: (tab: PaletteTab) => void;
  onGameOnly: () => void;
  onOpenAddons: (id?: AddonId) => void;
  onToggleAddon: (id: AddonId, enabled: boolean) => void;
  onCrowdCommand: (cmd: CrowdCommand) => void;
  onExportProfile: () => void;
  onImportProfile: () => void;
}

interface Item {
  id: string;
  group: 'endereço' | 'ir para' | 'addons' | 'multidão' | 'app';
  label: ReactNode;
  /** Texto para casar com o que foi digitado. */
  keywords: string;
  hint?: string;
  run: () => void;
  /** Em vez de executar, preenche a paleta com este texto. */
  fill?: string;
}

const URL_SHORTCUTS = [
  { label: 'Habblet', url: 'https://habblet.city' },
  { label: 'Jogar (hotel)', url: 'https://habblet.city/hotel' },
];

function looksLikeUrl(q: string): boolean {
  return /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(q);
}

/**
 * Paleta Ctrl+K: um campo para tudo. Endereço (abre no jogo), ir para uma aba, ligar ou configurar um addon,
 * mandar um comando à Multidão (mesma gramática da barra de comando) e ações do app. Setas escolhem, Enter
 * executa, Esc fecha. Clique fora também fecha.
 */
export default function Palette(p: PaletteProps) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Montada só enquanto aberta (o App condiciona), então o estado nasce limpo; aqui só entra o foco.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const items = useMemo<Item[]>(() => {
    const text = q.trim();
    const lower = text.toLowerCase();
    const out: Item[] = [];
    const close = p.onClose;

    // Endereço: o que foi digitado parece URL, ou os atalhos.
    if (text && looksLikeUrl(text)) {
      const url = text.startsWith('http') ? text : `https://${text}`;
      out.push({ id: 'url:' + url, group: 'endereço', label: <>Abrir <span className="font-mono text-fg">{url}</span></>, keywords: url, run: () => { p.onNavigate(url); close(); } });
    }
    for (const s of URL_SHORTCUTS) out.push({ id: 'url:' + s.url, group: 'endereço', label: <>Abrir {s.label}</>, keywords: `${s.label} ${s.url} abrir endereço url`, hint: s.url, run: () => { p.onNavigate(s.url); close(); } });
    out.push({ id: 'reload', group: 'endereço', label: 'Recarregar a página do jogo', keywords: 'recarregar reload atualizar página', run: () => { p.onReload(); close(); } });

    // Ir para
    out.push({ id: 'tab:jogo', group: 'ir para', label: 'Jogo (só a tela, recolhe o painel)', keywords: 'jogo tela recolher painel', hint: 'Ctrl+J', run: () => { p.onGameOnly(); close(); } });
    const tabs: { t: PaletteTab; label: string; kw: string }[] = [
      { t: 'crowd', label: 'Multidão', kw: 'multidão contas crowd' },
      { t: 'game', label: 'Sala', kw: 'sala quarto amigos pedidos eventos' },
      { t: 'protocol', label: 'Protocolo', kw: 'protocolo pacotes sniffer' },
      { t: 'logs', label: 'Logs', kw: 'logs linha do tempo' },
      { t: 'board', label: 'Board da fila', kw: 'board fila add user all' },
    ];
    for (const tb of tabs) out.push({ id: 'tab:' + tb.t, group: 'ir para', label: tb.label, keywords: tb.kw, run: () => { p.onTab(tb.t); close(); } });
    out.push({ id: 'addons', group: 'ir para', label: 'Addons', keywords: 'addons gaveta', hint: 'Ctrl+,', run: () => { p.onOpenAddons(); close(); } });

    // Addons: ligar/desligar e configurar
    for (const d of ADDONS) {
      const on = p.enabled[d.id];
      out.push({ id: 'addon:' + d.id, group: 'addons', label: <>{on ? 'Desligar' : 'Ligar'} <span className="font-semibold text-fg">{d.name}</span></>, keywords: `${d.name} ${d.id} ${on ? 'desligar desativar' : 'ligar ativar'} addon`, hint: on ? 'ativo' : undefined, run: () => { p.onToggleAddon(d.id, !on); close(); } });
      out.push({ id: 'cfg:' + d.id, group: 'addons', label: <>Configurar <span className="font-semibold text-fg">{d.name}</span></>, keywords: `${d.name} ${d.id} configurar configurações addon`, run: () => { p.onOpenAddons(d.id); close(); } });
    }

    // Multidão: o que foi digitado é um comando? Executa em todas as online. Verbos parciais viram sugestões.
    if (text && (text.startsWith(':') || findSpec(text.split(/\s+/)[0]))) {
      const r = parseCrowdCommand(text);
      if (r.ok) {
        out.unshift({ id: 'crowd:run', group: 'multidão', label: <>Multidão: {describeCommand(r.command)}</>, keywords: text, hint: p.crowdOnline ? `${p.crowdOnline} conta(s) online` : 'nenhuma conta online', run: () => { p.onCrowdCommand(r.command); close(); } });
      } else {
        out.unshift({ id: 'crowd:err', group: 'multidão', label: <span className="text-warn">{r.error}</span>, keywords: text, run: () => {} });
      }
    }
    if (text && !text.includes(' ')) {
      for (const s of suggestCommands(text, p.serverCommands, 5)) {
        if (s.spec && s.spec.verb === lower) continue;
        out.push({ id: 'crowd:sug:' + s.label, group: 'multidão', label: <span className="font-mono">{s.label}</span>, keywords: s.label + ' ' + s.hint, hint: s.hint, fill: s.insert, run: () => {} });
      }
    }

    // App
    out.push({ id: 'export', group: 'app', label: 'Exportar perfil de configurações', keywords: 'exportar perfil json configurações', run: () => { p.onExportProfile(); close(); } });
    out.push({ id: 'import', group: 'app', label: 'Importar perfil de configurações', keywords: 'importar perfil json configurações', run: () => { p.onImportProfile(); close(); } });

    if (!lower) return out.filter((it) => it.group !== 'multidão' || it.id === 'crowd:run');
    // Filtro: tudo o que casa com o texto; itens de endereço/comando gerados a partir do texto sempre ficam.
    return out.filter((it) => it.id.startsWith('url:https://' + lower) || it.id.startsWith('crowd:') || it.keywords.toLowerCase().includes(lower) || (typeof it.label === 'string' && it.label.toLowerCase().includes(lower)));
  }, [q, p]);

  const cur = items.length ? Math.min(cursor, items.length - 1) : 0;

  const activate = (it: Item) => {
    if (it.fill !== undefined) { setQ(it.fill); setCursor(0); inputRef.current?.focus(); return; }
    it.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); p.onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((cur + 1) % Math.max(1, items.length)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((cur - 1 + Math.max(1, items.length)) % Math.max(1, items.length)); return; }
    if (e.key === 'Tab' && items[cur]?.fill !== undefined) { e.preventDefault(); activate(items[cur]); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (items[cur]) activate(items[cur]); }
  };

  let lastGroup: Item['group'] | null = null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]" role="dialog" aria-modal="true" aria-label="Paleta de comandos">
      <div className="absolute inset-0 bg-bg/40 backdrop-blur-[2px]" onClick={p.onClose} aria-hidden />
      <div className="glass-strong animate-rise relative flex w-[640px] max-w-[calc(100%-32px)] flex-col overflow-hidden rounded-[20px] shadow-sheet">
        <div className="flex h-14 items-center gap-3 border-b border-line px-5">
          <svg className="h-4 w-4 shrink-0 text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" /></svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setCursor(0); }}
            onKeyDown={onKeyDown}
            placeholder="endereço, aba, addon ou um comando para a Multidão…"
            aria-label="Buscar ou comandar"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder-dim"
          />
          <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10.5px] text-dim">Esc</span>
        </div>
        <ul role="listbox" className="max-h-[52vh] overflow-y-auto p-2">
          {items.length === 0 && <li className="px-4 py-6 text-center text-[12.5px] text-dim">Nada corresponde. Um endereço (habblet.city/hotel), uma aba, um addon ou um comando (sentar, ir até Fulano…).</li>}
          {items.map((it, i) => {
            const showGroup = it.group !== lastGroup;
            lastGroup = it.group;
            return (
              <li key={it.id} role="option" aria-selected={i === cur}>
                {showGroup && <div className="px-3 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim">{it.group}</div>}
                <button
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => activate(it)}
                  className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] text-fg-2', i === cur ? 'bg-fg/[0.08] text-fg' : 'hover:bg-fg/[0.05]')}
                >
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="shrink-0 font-mono text-[10.5px] text-dim">{it.hint}</span>}
                  {it.fill !== undefined && <span className="shrink-0 text-[10.5px] text-dim">Tab</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex h-9 items-center gap-4 border-t border-line px-5 text-[10.5px] text-dim">
          <span>↑↓ escolher</span><span>Enter executar</span><span>Esc fechar</span>
          <span className="ml-auto">comandos da Multidão vão para todas as contas online</span>
        </div>
      </div>
    </div>
  );
}
