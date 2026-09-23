/**
 * De onde veio cada linha do painel Logs. As linhas chegam como texto (motores, Multidão, Colar quarto,
 * scripts DOM), então a origem é lida do prefixo entre colchetes: os motores usam o `logPrefix` do registro
 * (`[Auto Message] `…; o Add User All não tem prefixo), a Multidão usa `[<nick da conta>] ` ou `[multidão] `,
 * e a colagem `[Colar quarto] `. Sem colchetes é addon.
 */
import { ADDONS } from '../addons/registry';

export type LogSource = 'addons' | 'crowd' | 'paste' | 'system';

export const LOG_SOURCES: { id: LogSource; label: string; bar: string }[] = [
  { id: 'addons', label: 'Addons', bar: 'bg-accent/70' },
  { id: 'crowd', label: 'Multidão', bar: 'bg-violet/70' },
  { id: 'paste', label: 'Colar quarto', bar: 'bg-warn/70' },
  { id: 'system', label: 'Sistema', bar: 'bg-dim' },
];

const ADDON_TAGS = new Set<string>();
for (const d of ADDONS) {
  const m = /^\[(.+?)\]/.exec(d.logPrefix);
  if (m) ADDON_TAGS.add(m[1].toLowerCase());
  const dm = d.dom?.logs?.prefix ? /^\[(.+?)\]/.exec(d.dom.logs.prefix) : null;
  if (dm) ADDON_TAGS.add(dm[1].toLowerCase());
}

export function logSource(msg: string): LogSource {
  const m = /^\[([^\]]+)\]/.exec(msg);
  if (!m) return 'addons';
  const tag = m[1].toLowerCase();
  if (ADDON_TAGS.has(tag)) return 'addons';
  if (tag === 'colar quarto') return 'paste';
  if (tag === 'app' || tag === 'sistema') return 'system';
  return 'crowd';
}
