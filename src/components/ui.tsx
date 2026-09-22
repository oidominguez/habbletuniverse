/**
 * Kit de interface do Habblet AddAll ("Ink & Mint"). Todo controle denso do app sai daqui, para que
 * altura, raio, tipografia e estados (hover, ativo, desabilitado) sejam os mesmos em qualquer painel.
 *
 * Escala de tamanho compartilhada por botões e campos:
 *   sm = 24 px (listas densas e chips de ação) · md = 28 px (formulários e barras) · lg = 32 px (destaque).
 * Regras que evitam o caos visual que existia nos painéis:
 *   - botão nunca quebra linha nem encolhe (whitespace-nowrap + shrink-0); quem quebra é a Toolbar;
 *   - campo sempre pode encolher (min-w-0) e, dentro de uma FormRow, cresce para ocupar o que sobrar;
 *   - texto longo em linha trunca (truncate) em vez de empurrar os vizinhos.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

import { cx } from './cx';

export type Size = 'sm' | 'md' | 'lg';
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';

const BTN_BASE = 'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium leading-none outline-none transition-colors disabled:pointer-events-none disabled:opacity-40';
const BTN_SIZE: Record<Size, string> = {
  sm: 'h-6 px-2 text-[10.5px]',
  md: 'h-7 px-2.5 text-[11px]',
  lg: 'h-8 px-3 text-[12px]',
};
const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-strong',
  secondary: 'border border-line bg-raised text-fg-2 hover:border-line-strong hover:text-fg',
  ghost: 'text-muted hover:bg-raised/70 hover:text-fg',
  danger: 'border border-danger/40 bg-raised text-danger hover:border-danger',
  accent: 'border border-accent/60 bg-accent/10 text-accent hover:bg-accent/15',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: Size;
  /** Estado "ligado" de um botão-interruptor (auto, filtro, alvo selecionado): vira o visual `accent`. */
  active?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', active, className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={cx(BTN_BASE, BTN_SIZE[size], BTN_VARIANT[active ? 'accent' : variant], className)} {...rest} />;
}

/** Botão só com ícone/glifo (×, ⟳): quadrado, sem borda. */
export function IconButton({ size = 'md', className, ...rest }: ButtonProps) {
  const dim = size === 'sm' ? 'h-6 w-6' : size === 'lg' ? 'h-8 w-8' : 'h-7 w-7';
  return <button type="button" className={cx('inline-flex shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-raised/70 hover:text-fg disabled:pointer-events-none disabled:opacity-40', dim, className)} {...rest} />;
}

const FIELD_BASE = 'min-w-0 rounded-md border border-line bg-bg text-fg outline-none transition-colors placeholder-dim focus:border-accent disabled:opacity-40';
const FIELD_SIZE: Record<Size, string> = {
  sm: 'h-6 px-1.5 text-[10.5px]',
  md: 'h-7 px-2 text-[11px]',
  lg: 'h-8 px-2.5 text-[12px]',
};

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: Size;
  mono?: boolean;
}

export function Input({ size = 'md', mono, className, ...rest }: InputProps) {
  return <input className={cx(FIELD_BASE, FIELD_SIZE[size], mono && 'font-mono', className)} {...rest} />;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: Size;
  mono?: boolean;
}

export function Select({ size = 'md', mono, className, ...rest }: SelectProps) {
  return <select className={cx(FIELD_BASE, FIELD_SIZE[size], mono && 'font-mono', className)} {...rest} />;
}

export function TextArea({ mono, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={cx(FIELD_BASE, 'w-full px-2 py-1.5 text-[11px] leading-relaxed', mono && 'font-mono', className)} {...rest} />;
}

/** Linha de formulário: campos crescem, botões ficam inteiros, e o que não cabe desce de linha. */
export function FormRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('flex flex-wrap items-center gap-1.5', className)}>{children}</div>;
}

/** Barra de ações: mesma coisa que FormRow, com o nome certo para quem lê. */
export function Toolbar(props: { children: ReactNode; className?: string }) {
  return <FormRow {...props} />;
}

/** Cartão de seção: título, descrição curta e ações à direita, conteúdo abaixo. */
export function Card({ title, description, actions, children, className, bodyClassName }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface p-3', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h3 className="text-[12px] font-semibold tracking-tight text-fg">{title}</h3>}
            {description && <p className="mt-0.5 text-[11px] leading-relaxed text-dim">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      {!title && description && <p className="text-[11px] leading-relaxed text-dim">{description}</p>}
      {children !== undefined && children !== null && <div className={cx(Boolean(title || description) && 'mt-2.5', bodyClassName)}>{children}</div>}
    </section>
  );
}

export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warn' | 'danger' | 'violet';

const CHIP_TONE: Record<Tone, string> = {
  neutral: 'bg-raised text-muted',
  accent: 'bg-accent/15 text-accent',
  info: 'bg-info/15 text-info',
  success: 'bg-success/15 text-success',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
  violet: 'bg-violet/15 text-violet',
};

/** Etiqueta curta em linha (transporte, alvo, posição). Nunca quebra; trunca se precisar. */
export function Chip({ tone = 'neutral', mono, className, title, children }: { tone?: Tone; mono?: boolean; className?: string; title?: string; children: ReactNode }) {
  return <span title={title} className={cx('inline-flex h-[18px] max-w-full items-center truncate whitespace-nowrap rounded px-1.5 text-[10px] font-medium leading-none', CHIP_TONE[tone], mono && 'font-mono', className)}>{children}</span>;
}

/** Selo de estado (ONLINE, LOGIN, ERRO…): caixa alta, letra pequena, sempre da mesma largura mínima. */
export function StatusPill({ tone = 'neutral', solid, className, children }: { tone?: Tone; solid?: boolean; className?: string; children: ReactNode }) {
  const solidCls: Record<Tone, string> = { ...CHIP_TONE, warn: 'bg-warn text-accent-ink', accent: 'bg-accent text-accent-ink' };
  return <span className={cx('inline-flex h-[18px] min-w-[52px] shrink-0 items-center justify-center whitespace-nowrap rounded px-1.5 text-[9px] font-semibold uppercase tracking-wider leading-none', (solid ? solidCls : CHIP_TONE)[tone], className)}>{children}</span>;
}

/** Bolinha de estado ao lado de um nome. */
export function Dot({ tone = 'neutral', pulse, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  const bg: Record<Tone, string> = { neutral: 'bg-line-strong', accent: 'bg-accent', info: 'bg-info', success: 'bg-success', warn: 'bg-warn', danger: 'bg-danger', violet: 'bg-violet' };
  return <span className={cx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', bg[tone], pulse && 'animate-pulse-dot', className)} />;
}

/** Abas em trilho (segmented control), como as do dock. */
export function SegmentedTabs<T extends string>({ value, onChange, items, size = 'sm' }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; title?: string }[]; size?: Size }) {
  const h = size === 'sm' ? 'h-6 px-2.5 text-[11px]' : 'h-7 px-3 text-[12px]';
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-bg p-0.5">
      {items.map((it) => (
        <button key={it.value} type="button" title={it.title} onClick={() => onChange(it.value)} className={cx('whitespace-nowrap rounded-md font-medium transition-colors', h, value === it.value ? 'bg-raised text-fg' : 'text-muted hover:text-fg')}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Rótulo-legenda em caixa alta (cabeçalho de coluna, "Tela", "Alvo"). */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('text-[10px] uppercase tracking-wider text-dim', className)}>{children}</span>;
}

/** Estado vazio de uma lista ou área. */
export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('flex h-full items-center justify-center px-6 py-4 text-center text-[11px] leading-relaxed text-dim', className)}>{children}</div>;
}

/** Linha "rótulo à esquerda, controle à direita" (interruptores em lista). */
export function SettingRow({ label, hint, control }: { label: ReactNode; hint?: ReactNode; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <div className="truncate text-[11px] text-fg-2">{label}</div>
        {hint && <div className="text-[10px] leading-snug text-dim">{hint}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
