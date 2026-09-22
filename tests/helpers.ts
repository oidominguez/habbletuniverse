/**
 * Utilidades dos testes: montam pacotes sintéticos com a mesma estrutura que os parsers esperam
 * (ver docs/PROTOCOLO.md) e capturam o que as ações enviam.
 */
import { PacketReader, PacketWriter, bytesToBase64 } from '../src/protocol/decode';
import type { ProtocolPacket } from '../shared/protocol';
import type { SendPacket } from '../src/protocol/actions';

let seq = 0;

export function w(): PacketWriter {
  return new PacketWriter();
}

/** Um ProtocolPacket como o agente entregaria. `t` em ms (padrão 1000). */
export function pkt(dir: 'in' | 'out', header: number, body: PacketWriter | Uint8Array = new Uint8Array(0), t = 1000): ProtocolPacket {
  const bytes = body instanceof PacketWriter ? body.bytes() : body;
  return {
    id: ++seq,
    t,
    dir,
    socketId: 1,
    header,
    length: bytes.length + 2,
    bodyLength: bytes.length,
    body: bytesToBase64(bytes),
    truncated: false,
  };
}

export const IN = (header: number, body?: PacketWriter | Uint8Array, t?: number) => pkt('in', header, body, t);
export const OUT = (header: number, body?: PacketWriter | Uint8Array, t?: number) => pkt('out', header, body, t);

/* ------------------------------------ escritores ------------------------------------ */

export interface FriendSpec {
  id: number;
  name: string;
  online?: boolean;
  motto?: string;
  figure?: string;
}

/** Estrutura de um amigo (3130 / 2800), igual ao parseFriend. */
export function writeFriend(wr: PacketWriter, f: FriendSpec): PacketWriter {
  return wr
    .int32(f.id)
    .string(f.name)
    .int32(0) // gender
    .boolean(f.online ?? true)
    .boolean(true) // followingAllowed
    .string(f.figure ?? 'hd-180-1')
    .int32(0) // categoryId
    .string(f.motto ?? '')
    .string('') // realName
    .string('') // facebookId
    .boolean(false) // persistedMessageUser
    .boolean(false) // vipMember
    .boolean(false) // pocketHabboUser
    .int16(0); // relationshipStatus
}

/** IN 3130 — um fragmento da lista de amigos. */
export function friendsList(friends: FriendSpec[], fragment = 0, totalFragments = 1): PacketWriter {
  const wr = w().int32(totalFragments).int32(fragment).int32(friends.length);
  for (const f of friends) writeFriend(wr, f);
  return wr;
}

/** IN 2800 — atualização da lista: `upserts` chegam como tipo 0 (como neste hotel), `removed` como -1. */
export function friendsUpdate(upserts: FriendSpec[], removed: number[] = []): PacketWriter {
  const wr = w().int32(0).int32(upserts.length + removed.length);
  for (const f of upserts) writeFriend(wr.int32(0), f);
  for (const id of removed) wr.int32(-1).int32(id);
  return wr;
}

/** IN 2725 — dados do próprio usuário. */
export function selfInfo(id: number, name: string, motto = ''): PacketWriter {
  return w().int32(id).string(name).string('hd-180-1').string('M').string(motto).string('').boolean(false).int32(0).int32(0).int32(0);
}

/** IN 2219 — pedido de amizade recebido. */
export function friendRequest(userId: number, name: string): PacketWriter {
  return w().int32(userId).string(name).string('hd-180-1');
}

export interface RoomUserSpec {
  id: number;
  name: string;
  roomIndex: number;
  x?: number;
  y?: number;
  motto?: string;
  /** 1 usuário (padrão), 2 pet, 3 bot. */
  type?: number;
}

/** IN 374 — lista de unidades na sala. */
export function roomUsers(users: RoomUserSpec[]): PacketWriter {
  const wr = w().int32(users.length);
  for (const u of users) {
    const type = u.type ?? 1;
    wr.int32(u.id).string(u.name).string(u.motto ?? '').string('hd-180-1').int32(u.roomIndex).int32(u.x ?? 0).int32(u.y ?? 0).string('0.0').int32(2).int32(type);
    if (type === 1) wr.string('M').int32(0).int32(0).string('').string('').int32(0).boolean(false);
    else if (type === 2) {
      wr.int32(0).int32(0).string('').int32(0);
      for (let i = 0; i < 6; i++) wr.boolean(false);
      wr.int32(0).string('');
    }
  }
  return wr;
}

/** IN 1640 — status/movimento. */
export function unitStatuses(list: { roomIndex: number; x: number; y: number; actions: string }[]): PacketWriter {
  const wr = w().int32(list.length);
  for (const s of list) wr.int32(s.roomIndex).int32(s.x).int32(s.y).string('0.0').int32(2).int32(2).string(s.actions);
  return wr;
}

/** IN 2661 — unidade saiu (roomIndex como string). */
export function unitRemove(roomIndex: number): PacketWriter {
  return w().string(String(roomIndex));
}

/** IN 1446 / 1036 / 2704 — fala. */
export function chat(roomIndex: number, text: string): PacketWriter {
  return w().int32(roomIndex).string(text).int32(0).int32(0).int32(0).int32(-1);
}

/** IN 1587 — mensagem do console. */
export function consoleMessage(senderId: number, text: string, secondsSinceSent = 0): PacketWriter {
  return w().int32(senderId).string(text).int32(secondsSinceSent);
}

export interface RoomSpec {
  roomId: number;
  name: string;
  userCount?: number;
  maxUserCount?: number;
  doorMode?: number;
  ownerName?: string;
}

/** RoomDataParser (usado por 687 e 2690). */
export function writeRoomData(wr: PacketWriter, r: RoomSpec): PacketWriter {
  return wr
    .int32(r.roomId)
    .string(r.name)
    .int32(1)
    .string(r.ownerName ?? 'dono')
    .int32(r.doorMode ?? 0)
    .int32(r.userCount ?? 0)
    .int32(r.maxUserCount ?? 50)
    .string('')
    .int32(0)
    .int32(0)
    .int32(0)
    .int32(0)
    .int32(0) // tags
    .int32(0); // bitmask
}

/** IN 687 — dados do quarto. */
export function roomData(r: RoomSpec, enterRoom = true): PacketWriter {
  return writeRoomData(w().boolean(enterRoom), r);
}

/** IN 2690 — resultados do navegador num único bloco. */
export function navigatorResults(rooms: RoomSpec[], code = 'hotel_view'): PacketWriter {
  const wr = w().string(code).string('').int32(1).string(code).string('Populares').int32(0).boolean(false).int32(0).int32(rooms.length);
  for (const r of rooms) writeRoomData(wr, r);
  return wr;
}

/** IN 899 — entrada recusada. */
export function roomEnterError(reason: number, parameter = ''): PacketWriter {
  return w().int32(reason).string(parameter);
}

/* ------------------------------------ mobis de chão ------------------------------------ */

export interface FloorItemSpec {
  id: number;
  spriteId: number;
  x: number;
  y: number;
  direction?: number;
  z?: number;
  stackHeight?: number;
  ownerId?: number;
  /** Estado legado (dados tipo 0). */
  state?: string;
  /** Edição limitada (flag 0x100 no tipo dos dados): número e série no fim. */
  unique?: { number: number; series: number };
}

/** Um mobi de chão com dados legados (tipo 0), como no 1778/1534/3776. */
export function writeFloorItem(wr: PacketWriter, f: FloorItemSpec): PacketWriter {
  wr.int32(f.id).int32(f.spriteId).int32(f.x).int32(f.y).int32(f.direction ?? 0).string(String(f.z ?? 0)).string(String(f.stackHeight ?? 1)).int32(1);
  wr.int32(f.unique ? 0x100 : 0).string(f.state ?? '0');
  if (f.unique) wr.int32(f.unique.number).int32(f.unique.series);
  return wr.int32(-1).int32(1).int32(f.ownerId ?? 1);
}

/** IN 1778 — mobis de chão do quarto, com a tabela de donos. */
export function floorItems(items: FloorItemSpec[], owners: Record<number, string> = { 1: 'Dono' }): PacketWriter {
  const wr = w().int32(Object.keys(owners).length);
  for (const [id, name] of Object.entries(owners)) wr.int32(parseInt(id, 10)).string(name);
  wr.int32(items.length);
  for (const it of items) writeFloorItem(wr, it);
  return wr;
}

/** IN 1534 — mobi colocado (mobi + nome do dono). */
export function floorItemAdd(item: FloorItemSpec, ownerName = 'Dono'): PacketWriter {
  return writeFloorItem(w(), item).string(ownerName);
}

/** IN 2703 — mobi removido. */
export function floorItemRemove(id: number): PacketWriter {
  return w().string(String(id)).boolean(false).int32(0).int32(0);
}

/** IN 286 — diálogo do servidor: só strings. */
export function serverDialog(...strings: string[]): PacketWriter {
  const wr = w();
  for (const s of strings) wr.string(s);
  return wr;
}

/* ------------------------------------ envio ------------------------------------ */

export interface SentPacket {
  header: number;
  body: Uint8Array;
  reader: () => PacketReader;
}

/** Captura tudo que as ações enviam. */
export function captureSends(): { sent: SentPacket[]; send: SendPacket; byHeader: (h: number) => SentPacket[]; clear: () => void } {
  const sent: SentPacket[] = [];
  return {
    sent,
    send: (header, body) => {
      sent.push({ header, body, reader: () => new PacketReader(body) });
    },
    byHeader: (h) => sent.filter((p) => p.header === h),
    clear: () => sent.splice(0, sent.length),
  };
}
