import type { ProxyPoolEntry, ProxyPoolStatus } from '../../shared/crowd';
import type { Tone } from './ui';

/** Como cada status do pool aparece: no seletor da conta e na tabela do pool. */
export const POOL_STATUS: Record<ProxyPoolStatus, { label: string; tone: Tone; order: number }> = {
  ok: { label: 'ok', tone: 'accent', order: 0 },
  unknown: { label: 'não testado', tone: 'neutral', order: 1 },
  error: { label: 'erro', tone: 'warn', order: 2 },
  blocked: { label: 'anti-VPN', tone: 'danger', order: 3 },
};

/** Texto de um item do pool no seletor: rótulo ou host:porta, status, IP e quem já usa. */
export function poolOptionText(p: ProxyPoolEntry, usedBy: string[]): string {
  const parts = [p.label || p.display, POOL_STATUS[p.status].label];
  if (p.lastIp) parts.push(p.lastIp);
  if (usedBy.length) parts.push(`em uso: ${usedBy.join(', ')}`);
  return parts.join(' · ');
}

export function sortPool(list: readonly ProxyPoolEntry[]): ProxyPoolEntry[] {
  return [...list].sort((a, b) => POOL_STATUS[a.status].order - POOL_STATUS[b.status].order || a.createdAt - b.createdAt);
}
