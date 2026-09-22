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
      <label className="block text-[13px] font-medium text-fg-2">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value) || 0)}
        min={1}
        className="tnum w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg outline-none transition-colors placeholder-dim focus:border-accent"
      />
      {hint && <p className="text-xs leading-snug text-dim">{hint}</p>}
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
        <span className="text-[13px] font-medium text-fg-2">{label}</span>
        <Switch checked={checked} onChange={onChange} />
      </div>
      {hint && <p className="text-xs leading-snug text-dim">{hint}</p>}
    </div>
  );
}

/** Interruptor padrão do app: trilho discreto, menta quando ligado. */
export function Switch({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer items-center rounded-full border transition-colors ${
        checked ? 'border-accent bg-accent' : 'border-line-strong bg-raised hover:border-dim'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full shadow-sm transition-transform ${
          checked ? 'translate-x-[19px] bg-accent-ink' : 'translate-x-[3px] bg-muted'
        }`}
      />
    </button>
  );
}
