import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Switch } from './ConfigInputs';

export interface SettingsShellProps {
  title: string;
  isDirty: boolean;
  onSave: () => void;
  onRevert: () => void;
  onBack: () => void;
  onReset: () => void;
  /** Aviso "alterações não salvas", controlado pelo pai (a gaveta) para que clique fora e Esc também o acionem. */
  leaveWarning: boolean;
  onLeaveWarning: (show: boolean) => void;
  children: ReactNode;
}

/**
 * Moldura comum de toda tela de configurações: cabeçalho com Voltar, seções (children),
 * barra fixa de ações no rodapé (Salvar / Descartar / Restaurar) e aviso de não salvo.
 */
export default function SettingsShell({
  title, isDirty, onSave, onRevert, onBack, onReset,
  leaveWarning, onLeaveWarning, children,
}: SettingsShellProps) {
  const warningRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (leaveWarning) warningRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [leaveWarning]);

  const handleBack = () => {
    if (isDirty) onLeaveWarning(true);
    else onBack();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        <button onClick={handleBack} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg" title="Voltar">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        </button>
        <h2 className="text-sm font-semibold tracking-tight text-fg">{title}</h2>
        {isDirty && <span className="ml-auto rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium text-warn">não salvo</span>}
      </header>

      <main className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {children}
      </main>

      {leaveWarning && (
        <div ref={warningRef} className="shrink-0 border-t border-warn/30 bg-warn/10 px-4 py-3 animate-fade-up">
          <p className="mb-2 text-[13px] font-medium text-warn">Você tem alterações não salvas.</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => { onSave(); onBack(); }} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent-strong">Salvar e sair</button>
            <button onClick={() => { onRevert(); onBack(); }} className="rounded-md border border-line bg-raised px-3 py-1.5 text-xs text-fg-2 hover:border-line-strong">Descartar e sair</button>
            <button onClick={() => onLeaveWarning(false)} className="rounded-md px-3 py-1.5 text-xs text-muted hover:text-fg">Continuar editando</button>
          </div>
        </div>
      )}

      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
        <button onClick={onSave} disabled={!isDirty} className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent-strong disabled:cursor-default disabled:opacity-30">Salvar</button>
        <button onClick={onRevert} disabled={!isDirty} className="rounded-md border border-line bg-raised px-3 py-1.5 text-xs text-fg-2 hover:border-line-strong disabled:cursor-default disabled:opacity-30">Descartar</button>
        <button onClick={onReset} className="ml-auto text-xs text-dim hover:text-fg">Restaurar padrão</button>
      </footer>
    </div>
  );
}

/** Seção padrão (cartão) com título opcional e texto de apoio. */
export function Section({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-bg/40 p-4">
      {title && <h3 className={`text-[13px] font-semibold tracking-tight text-fg ${hint ? 'mb-1' : 'mb-3'}`}>{title}</h3>}
      {hint && <p className="mb-3 text-xs leading-relaxed text-dim">{hint}</p>}
      {children}
    </section>
  );
}

/** Editor de lista de strings (nomes a ignorar, comandos…) com o campo de entrada local. */
export function TagListEditor({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [input, setInput] = useState('');
  const add = () => {
    const v = input.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setInput('');
  };
  return (
    <div className="flex flex-wrap gap-1.5 rounded-lg border border-line bg-bg p-2">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-md bg-raised px-2 py-1 text-xs text-fg-2">
          {v}
          <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} className="rounded p-0.5 leading-none text-dim hover:text-danger" title="Remover">×</button>
        </span>
      ))}
      <div className="flex min-w-[160px] flex-1 items-center gap-1">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className="min-w-0 flex-1 border-0 bg-transparent px-1.5 py-1 text-sm text-fg outline-none placeholder-dim"
        />
        <button type="button" onClick={add} className="shrink-0 rounded-md bg-raised px-2 py-1 text-xs text-fg-2 hover:bg-line">Adicionar</button>
      </div>
    </div>
  );
}

/** Campo de texto simples no estilo das telas de configuração. */
export function TextField({ label, value, onChange, placeholder, hint }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[13px] font-medium text-fg-2">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg outline-none transition-colors placeholder-dim focus:border-accent"
      />
      {hint && <p className="text-xs leading-snug text-dim">{hint}</p>}
    </div>
  );
}

/** Toggle "Usar protocolo" padrão das telas com dois motores. */
export function EngineToggle({ engine, onChange, label, hint }: { engine: 'protocol' | 'dom'; onChange: (e: 'protocol' | 'dom') => void; label: string; hint: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-fg-2">{label}</span>
        <Switch checked={engine === 'protocol'} onChange={(v) => onChange(v ? 'protocol' : 'dom')} />
      </div>
      <p className="text-xs leading-snug text-dim">{hint}</p>
    </div>
  );
}
