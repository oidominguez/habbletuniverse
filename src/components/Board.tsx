import { memo } from 'react';

export type BoardVariant = 'warning' | 'blue' | 'success' | 'muted';

export const StatCard = memo(function StatCard({ label, value, variant }: { label: string; value: number; variant: BoardVariant }) {
  const colors = { warning: 'text-warn', blue: 'text-info', success: 'text-success', muted: 'text-muted' };
  return (
    <div className="rounded-2xl border border-line bg-fg/[0.03] p-4 transition-colors hover:border-line-strong">
      <div className="mb-1 text-[10.5px] uppercase tracking-[0.1em] text-dim">{label}</div>
      <div className={`font-display text-2xl font-semibold ${colors[variant]}`}>{value}</div>
    </div>
  );
});

export const BoardColumn = memo(function BoardColumn({ title, names, variant }: { title: string; names: string[]; variant: BoardVariant }) {
  const dot = { warning: 'bg-warn', blue: 'bg-info', success: 'bg-success', muted: 'bg-dim' };
  return (
    <div className="flex min-w-0 flex-col rounded-2xl border border-line bg-fg/[0.03]">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span className={`h-2 w-2 rounded-full ${dot[variant]}`} />
        <span className="text-[12px] font-medium text-fg-2">{title}</span>
        <span className="tnum ml-auto rounded-full bg-fg/[0.06] px-2 py-0.5 font-mono text-[10.5px] text-muted">{names.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {names.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-dim">—</p>
        ) : (
          <ul className="space-y-0.5">
            {names.map((n, i) => (
              <li key={`${n}-${i}`} className="truncate rounded-lg px-2.5 py-1 text-[12px] text-fg-2 hover:bg-fg/[0.04]">{n}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});
