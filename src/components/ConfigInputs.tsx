export function ConfigInput({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[12px] font-medium text-fg-2">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value) || 0)}
        min={1}
        className="tnum h-[32px] w-full rounded-full border border-line bg-fg/[0.04] px-3.5 font-mono text-[12.5px] text-fg outline-none transition-colors placeholder-dim focus:border-accent/60"
      />
      {hint && <p className="text-[11px] leading-snug text-dim">{hint}</p>}
    </div>
  );
}

export function ConfigCheckbox({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] font-medium text-fg-2">{label}</span>
        <Switch checked={checked} onChange={onChange} />
      </div>
      {hint && <p className="text-[11px] leading-snug text-dim">{hint}</p>}
    </div>
  );
}

/** Interruptor padrão do app: trilho escuro, acento quando ligado, botão branco (como no iOS). */
export function Switch({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-line-strong hover:bg-dim/70'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.45)] transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  );
}
