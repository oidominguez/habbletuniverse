import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Switch } from './ConfigInputs';
import { Button } from './ui';

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
      <header className="flex shrink-0 flex-col gap-2.5 border-b border-line px-7 pb-4 pt-6">
        <button onClick={handleBack} className="flex items-center gap-1.5 self-start text-[12.5px] text-muted hover:text-fg" title="Voltar">
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" /></svg>
          Addons
        </button>
        <div className="flex items-center gap-3">
          <h2 className="font-display text-[24px] font-semibold tracking-tight text-fg">{title}</h2>
          {isDirty && <span className="ml-auto rounded-full bg-warn/[0.14] px-2.5 py-0.5 text-[10.5px] font-semibold text-warn">não salvo</span>}
        </div>
      </header>

      <main className="min-h-0 flex-1 space-y-4 overflow-y-auto px-7 py-5">
        {children}
      </main>

      {leaveWarning && (
        <div ref={warningRef} className="shrink-0 border-t border-warn/30 bg-warn/10 px-7 py-3 animate-fade-up">
          <p className="mb-2 text-[13px] font-medium text-warn">Você tem alterações não salvas.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => { onSave(); onBack(); }}>Salvar e sair</Button>
            <Button onClick={() => { onRevert(); onBack(); }}>Descartar e sair</Button>
            <Button variant="ghost" onClick={() => onLeaveWarning(false)}>Continuar editando</Button>
          </div>
        </div>
      )}

      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-7 pb-5 pt-4">
        <Button variant="ghost" onClick={onReset}>Restaurar padrão</Button>
        <span className="flex-1" />
        <Button onClick={onRevert} disabled={!isDirty}>Descartar</Button>
        <Button variant="primary" onClick={onSave} disabled={!isDirty}>Salvar</Button>
      </footer>
    </div>
  );
}

/** Seção padrão (cartão) com título opcional e texto de apoio. */
export function Section({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-fg/[0.03] p-4">
      {title && <h3 className={`text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim ${hint ? 'mb-1' : 'mb-3'}`}>{title}</h3>}
      {hint && <p className="mb-3 text-[11.5px] leading-relaxed text-dim">{hint}</p>}
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
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((v) => (
        <span key={v} className="inline-flex h-6 items-center gap-1.5 rounded-full bg-fg/[0.06] pl-2.5 pr-1.5 text-[11.5px] font-medium text-fg-2">
          {v}
          <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} className="flex h-4 w-4 items-center justify-center rounded-full leading-none text-dim hover:bg-danger/20 hover:text-danger" title="Remover">×</button>
        </span>
      ))}
      <div className="flex min-w-[180px] flex-1 items-center gap-1">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className="h-6 min-w-0 flex-1 rounded-full border border-dashed border-line-strong bg-transparent px-2.5 text-[11.5px] text-fg outline-none placeholder-dim focus:border-accent/60"
        />
        <button type="button" onClick={add} className="h-6 shrink-0 rounded-full px-2.5 text-[11.5px] font-medium text-muted hover:text-fg">Adicionar</button>
      </div>
    </div>
  );
}

/** Campo de texto simples no estilo das telas de configuração. */
export function TextField({ label, value, onChange, placeholder, hint }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[12px] font-medium text-fg-2">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-[32px] w-full rounded-full border border-line bg-fg/[0.04] px-3.5 text-[12.5px] text-fg outline-none transition-colors placeholder-dim focus:border-accent/60"
      />
      {hint && <p className="text-[11px] leading-snug text-dim">{hint}</p>}
    </div>
  );
}

/** Toggle "Usar protocolo" padrão das telas com dois motores. */
export function EngineToggle({ engine, onChange, label, hint }: { engine: 'protocol' | 'dom'; onChange: (e: 'protocol' | 'dom') => void; label: string; hint: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] font-medium text-fg-2">{label}</span>
        <Switch checked={engine === 'protocol'} onChange={(v) => onChange(v ? 'protocol' : 'dom')} />
      </div>
      <p className="text-[11px] leading-snug text-dim">{hint}</p>
    </div>
  );
}
