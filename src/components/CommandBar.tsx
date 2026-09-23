import { useRef, useState } from 'react';
import type { CrowdCommand } from '../crowd/CrowdManager';
import { COMMAND_SPECS, parseCrowdCommand, suggestCommands } from '../crowd/commandParser';
import type { CommandSpec } from '../crowd/commandParser';
import { Eyebrow } from './ui';
import { cx } from './cx';

export interface CommandBarProps {
  /** Comandos de chat que o servidor anunciou às contas (432), para sugerir depois de ":". */
  serverCommands: readonly string[];
  /** Quantas contas o comando vai atingir (só para a legenda). */
  targetLabel: string;
  onRun: (cmd: CrowdCommand) => void;
  showToast: (m: string) => void;
}

const HISTORY_MAX = 50;

/**
 * A barra de comando da Multidão: uma linha para tudo o que as contas sabem fazer. Sugere verbos enquanto
 * digita (Tab ou Enter aceita, setas escolhem), lembra o que já foi enviado (seta para cima com a barra
 * vazia) e, abaixo, as pílulas por grupo: as sem argumento executam na hora, as outras preenchem o verbo.
 */
export default function CommandBar({ serverCommands, targetLabel, onRun, showToast }: CommandBarProps) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = open ? suggestCommands(text, serverCommands) : [];
  // O cursor pode apontar além da lista quando ela encolhe ao digitar: fica no último item válido.
  const cur = suggestions.length ? Math.min(cursor, suggestions.length - 1) : 0;

  const focus = () => inputRef.current?.focus();
  const fill = (insert: string) => {
    setText(insert);
    setOpen(true);
    setCursor(0);
    focus();
  };
  const submit = (line: string) => {
    const r = parseCrowdCommand(line);
    if (!r.ok) { showToast(r.error); return; }
    onRun(r.command);
    setHistory((h) => [line, ...h.filter((x) => x !== line)].slice(0, HISTORY_MAX));
    setHistIdx(-1);
    setText('');
    setOpen(false);
  };
  const pill = (spec: CommandSpec) => {
    if (spec.immediate) {
      const built = spec.build([], '');
      if (typeof built !== 'string') { onRun(built); return; }
    }
    fill(spec.verb + ' ');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (open && suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((cur + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((cur - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !text.includes(' ') && suggestions[cur] && suggestions[cur].insert.trim() !== text.trim())) {
        e.preventDefault();
        fill(suggestions[cur].insert);
        return;
      }
    }
    if (e.key === 'Enter') { e.preventDefault(); if (text.trim()) submit(text); return; }
    if (e.key === 'ArrowUp' && !text) {
      e.preventDefault();
      const i = Math.min(histIdx + 1, history.length - 1);
      if (history[i] !== undefined) { setHistIdx(i); setText(history[i]); }
      return;
    }
    if (e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault();
      const i = histIdx - 1;
      setHistIdx(i);
      setText(i >= 0 ? history[i] : '');
    }
  };

  const groups: { key: CommandSpec['group']; label: string }[] = [
    { key: 'fala', label: 'Fala' },
    { key: 'movimento', label: 'Movimento' },
    { key: 'quarto', label: 'Quarto' },
    { key: 'amizade', label: 'Amizade' },
    { key: 'postura', label: 'Postura' },
    { key: 'visual', label: 'Visual' },
  ];

  return (
    <div className="flex flex-col gap-3.5">
      <div className="relative">
        <label className="flex flex-col gap-1.5">
          <Eyebrow>Comando para {targetLabel}</Eyebrow>
          <div className="flex h-11 items-center gap-2.5 rounded-2xl border border-line-strong bg-fg/[0.04] pl-3.5 pr-2 focus-within:border-accent/60">
            <svg className="h-3.5 w-3.5 shrink-0 text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" /></svg>
            <input
              ref={inputRef}
              type="text"
              value={text}
              onChange={(e) => { setText(e.target.value); setOpen(true); setCursor(0); setHistIdx(-1); }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 120)}
              onKeyDown={onKeyDown}
              placeholder="falar, :sit, ir até Dominguez, entrar 7078217, sentar…"
              aria-label="Comando para as contas"
              aria-autocomplete="list"
              aria-expanded={open && suggestions.length > 0}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder-dim"
            />
            <span className="px-1.5 font-mono text-[10.5px] text-dim">Enter</span>
          </div>
        </label>
        {open && suggestions.length > 0 && (
          <ul role="listbox" className="glass-strong absolute left-0 right-0 top-full z-20 mt-1.5 max-h-64 overflow-y-auto rounded-2xl p-1.5 shadow-float">
            {suggestions.map((s, i) => (
              <li key={s.label} role="option" aria-selected={i === cur}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => (s.spec?.immediate && !s.spec.args ? submit(s.spec.verb) : fill(s.insert))}
                  onMouseEnter={() => setCursor(i)}
                  className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left', i === cur ? 'bg-fg/[0.08]' : 'hover:bg-fg/[0.05]')}
                >
                  <span className="font-mono text-[12px] text-fg">{s.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-dim">{s.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {groups.map((g) => {
        const specs = COMMAND_SPECS.filter((s) => s.group === g.key);
        return (
          <div key={g.key} className="flex flex-col gap-1.5">
            <Eyebrow>{g.label}</Eyebrow>
            <div className="flex flex-wrap gap-1.5">
              {specs.map((s) => (
                <button
                  key={s.verb}
                  type="button"
                  onClick={() => pill(s)}
                  title={`${s.verb}${s.args ? ' ' + s.args : ''} — ${s.description}${s.immediate ? '' : ' (preenche a barra)'}`}
                  className={cx('h-[30px] whitespace-nowrap rounded-full border px-3.5 text-[12px] font-medium transition-colors', s.immediate ? 'border-line bg-fg/[0.04] text-fg hover:border-line-strong hover:bg-fg/[0.07]' : 'border-line text-muted hover:border-line-strong hover:text-fg')}
                >
                  {capitalize(s.verb)}{s.args && <span className="ml-1 font-mono text-[10.5px] text-dim">{s.args}</span>}
                </button>
              ))}
              {g.key === 'fala' && serverCommands.length > 0 && (
                <button type="button" onClick={() => fill(':')} title="Comandos de chat que o servidor anunciou às contas (pacote 432): :sit, :dance, :empty…" className="h-[30px] whitespace-nowrap rounded-full border border-line px-3.5 font-mono text-[12px] text-muted hover:border-line-strong hover:text-fg">
                  :comando <span className="text-[10.5px] text-dim">{serverCommands.length}</span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
