/**
 * Reproduz uma captura NDJSON no GameState e imprime um resumo — teste de regressão
 * dos decodificadores contra tráfego real, sem abrir o jogo.
 *
 * uso: npm run proto:replay [-- caminho.ndjson] [--rooms]
 * (sem argumento usa %APPDATA%/habblet-addall/captures/latest.txt; --rooms lista entradas, saídas e recusas de quarto)
 */
import * as fs from 'fs';
import * as path from 'path';
import { GameState } from '../../src/protocol/state/GameState';
import type { GameEvent } from '../../src/protocol/state/GameState';
import type { ProtocolPacket } from '../../shared/protocol';

const arg = process.argv.slice(2).find((a) => a.endsWith('.ndjson'));
const showRooms = process.argv.includes('--rooms');
const latest = path.join(process.env.APPDATA ?? '', 'habblet-addall', 'captures', 'latest.txt');
const file = arg ?? fs.readFileSync(latest, 'utf8').trim();

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const state = new GameState();
let packets = 0;
// O log de eventos é limitado (EVENT_CAP); contamos tudo aqui acompanhando os eventos novos a cada pacote.
const totalByKind = new Map<string, number>();
let lastSeen: GameEvent | undefined;
const fmt = (t: number) => new Date(t).toISOString().slice(11, 23);
function onEvent(ev: GameEvent): void {
  totalByKind.set(ev.kind, (totalByKind.get(ev.kind) ?? 0) + 1);
  if (!showRooms) return;
  if (ev.kind === 'room-enter') console.log(`${fmt(ev.t)} entrou no quarto ${ev.roomId ?? '?'}`);
  else if (ev.kind === 'room-leave') console.log(`${fmt(ev.t)} saiu do quarto ${ev.roomId ?? '?'} "${ev.name ?? ''}" (${ev.reason})`);
  else if (ev.kind === 'room-enter-error') console.log(`${fmt(ev.t)} entrada recusada no quarto ${ev.roomId ?? '?'} (motivo ${ev.reason})`);
  else if (ev.kind === 'room-forward') console.log(`${fmt(ev.t)} encaminhado para o quarto ${ev.roomId}`);
}
for (const line of lines) {
  let e: { kind?: string } & Partial<ProtocolPacket>;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (e.kind !== 'packet') continue;
  packets++;
  state.handle(e as ProtocolPacket);
  const evs = state.snapshot().events;
  const fresh: GameEvent[] = [];
  for (let i = evs.length - 1; i >= 0 && evs[i] !== lastSeen; i--) fresh.unshift(evs[i]);
  if (evs.length) lastSeen = evs[evs.length - 1];
  for (const ev of fresh) onEvent(ev);
}

const s = state.snapshot();
const byKind = new Map<string, number>();
for (const ev of s.events) byKind.set(ev.kind, (byKind.get(ev.kind) ?? 0) + 1);
const errors = s.events.filter((ev) => ev.kind === 'decode-error') as Extract<(typeof s.events)[number], { kind: 'decode-error' }>[];
const errByHeader = new Map<number, string>();
for (const er of errors) if (!errByHeader.has(er.header)) errByHeader.set(er.header, er.message);

console.log(`arquivo: ${file}`);
console.log(`pacotes: ${packets}`);
console.log(`eu: ${s.me ? `${s.me.name} (id ${s.me.id}, missão "${s.me.motto}")` : '—'}`);
console.log(`amigos: ${s.friends.length} (${s.friends.filter((f) => f.online).length} online), lista completa: ${s.friendsLoaded}`);
console.log(`pedidos pendentes: ${s.pendingRequests.map((r) => `${r.name}#${r.requestId}`).join(', ') || '—'}`);
console.log(`nomes já pedidos nesta sessão: ${s.requestedNames.size}`);
console.log(`sala: ${s.room.id ?? '—'} "${s.room.name ?? ''}" dono=${s.room.ownerName ?? ''} usuários=${s.room.users.length}`);
console.log(`quartos do navegador: ${s.navigatorRooms.length}${s.navigatorRooms.length ? ' ex.: ' + s.navigatorRooms.slice(0, 3).map((r) => `${r.roomId} "${r.name}"`).join(', ') : ''}`);
console.log(`comandos Habblet: ${s.commands.length}${s.commands.length ? ' ex.: ' + s.commands.slice(0, 5).map((c) => c.command).join(' ') : ''}`);
console.log(`eventos (total): ${[...totalByKind.entries()].map(([k, n]) => `${k}=${n}`).join('  ')}`);
console.log(`eventos (últimos ${s.events.length}): ${[...byKind.entries()].map(([k, n]) => `${k}=${n}`).join('  ')}`);
console.log(`erros de decodificação: ${s.decodeErrors}`);
for (const [h, msg] of errByHeader) console.log(`  header ${h}: ${msg}`);

console.log('\nusuários na sala (primeiros 12):');
for (const u of s.room.users.slice(0, 12)) {
  console.log(`  idx ${u.roomIndex} id ${u.id} ${u.name} (${u.x},${u.y}) ${u.status.slice(0, 30)}${u.lastChat ? ` "${u.lastChat.text.slice(0, 40)}"` : ''}`);
}
console.log('\núltimos eventos de amizade:');
for (const ev of s.events.filter((e) => e.kind.startsWith('friend')).slice(-8)) console.log('  ', JSON.stringify(ev).slice(0, 160));
console.log('\núltimas falas:');
for (const ev of s.events.filter((e) => e.kind === 'chat').slice(-6)) console.log('  ', JSON.stringify(ev).slice(0, 160));
