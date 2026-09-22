import { memo } from 'react';

export type BoardVariant = 'warning' | 'blue' | 'success' | 'muted';

export const StatCard = memo(function StatCard({ label, value, variant }: { label: string; value: number; variant: BoardVariant }) {
  const colors = { warning: 'text-warn', blue: 'text-info', success: 'text-success', muted: 'text-muted' };
  return (
    <div className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-info/50">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-2xl font-semibold ${colors[variant]}`}>{value}</div>
    </div>
  );
});

export const BoardColumn = memo(function BoardColumn({ title, names, variant }: { title: string; names: string[]; variant: BoardVariant }) {
  const bg = { warning: 'border-warn/30', blue: 'border-info/30', success: 'border-success/30', muted: 'border-dim/30' };
  const dot = { warning: 'bg-warn', blue: 'bg-info', success: 'bg-success', muted: 'bg-dim' };
  return (
    <div className={`flex min-w-0 flex-col rounded-lg border ${bg[variant]} bg-bg/60`}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={`h-2 w-2 rounded-full ${dot[variant]}`} />
        <span className="text-xs font-medium text-muted">{title}</span>
        <span className="ml-auto rounded-full bg-raised px-1.5 py-0.5 text-[10px] text-muted">{names.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {names.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-dim">—</p>
        ) : (
          <ul className="space-y-1">
            {names.map((n, i) => (
              <li key={`${n}-${i}`} className="truncate rounded px-2 py-1 text-xs text-fg-2 hover:bg-raised">{n}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});
