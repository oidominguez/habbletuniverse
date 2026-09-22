/**
 * Serviço de estado do jogo, alimentado só pelo protocolo (sem DOM).
 *
 * Recebe cada pacote capturado e mantém: quem sou eu, amigos, pedidos pendentes,
 * a sala atual (usuários por roomIndex, posição, status, chat) e um log de eventos.
 * Consumido pela aba "Jogo" e, depois, pelos addons por protocolo.
 */
import { IN, OUT, UNIT_TYPE } from '../nitro/headers';
import {
  parseChat,
  parseConsoleMessage,
  parseEffect,
  parseFriendRequest,
  parseRespectReceived,
  parseUserProfile,
  parseFigureUpdate,
  parseFriendsFragment,
  parseFriendsUpdate,
  parseGenericError,
  parseGuestRoomResult,
  parseIdle,
  parseNavigatorResults,
  parseNameTag,
  parseRoomEnterError,
  parseRoomForward,
  parseRoomUsers,
  parseSelfInfo,
  parseUnitActions,
  parseServerDialog,
  parseTyping,
  parseUnitInfo,
  parseUnitRemove,
  parseUnitStatuses,
  parseHabbletCommands,
  parseFloorItems,
  parseFloorItemAdd,
  parseFloorItemRemove,
  parseFloorItem,
  parseWallItems,
  parseRoomPaint,
  parseFloorPlan,
  parseHeightMap,
  parseRoomEntryTile,
  parseOccupiedTiles,
  parseWallItemAdd,
  parseWallItemRemove,
  parseObjectDataUpdate,
  parseServerNotice,
  parseCatalogIndex,
  parseCatalogPage,
  parsePurchaseOk,
  parseUnseenItems,
  parseInventory,
} from '../nitro/parsers';
import type { CatalogNode, CatalogPage, FloorItem, FloorPlan, Friend, FriendRequest, HeightMap, InventoryItem, RoomData, RoomUser, SelfInfo, WallItem } from '../nitro/parsers';
import { PacketReader, base64ToBytes } from '../decode';
import type { ProtocolPacket } from '../../../shared/protocol';

export interface RoomUserState extends RoomUser {
  /** Campo `actions` cru do último 1640 (ex.: `/flatctrl 0/mv 31,31,0.0//`). */
  status: string;
  /** Nível de direitos (`/flatctrl N`): 0 nenhum, 1 direitos, 4 dono. */
  rights: number | null;
  /** Andando: alvo do próximo passo. */
  moveTarget: { x: number; y: number; z: number } | null;
  posture: 'sit' | 'lay' | null;
  /** Quando foi a última vez que o avatar se moveu (recebeu `/mv`). */
  lastMoveAt: number | null;
  typing: boolean;
  idle: boolean;
  effectId: number;
  lastChat?: { text: string; t: number };
  /** Tag/nome colorido custom do Habblet, se houver. */
  nameTagHtml?: string;
  enteredAt: number;
}

export interface RoomState {
  /** Id do quarto (do 2312 enviado / 687 recebido). */
  id: number | null;
  data: RoomData | null;
  enteredAt: number | null;
  users: Map<number, RoomUserState>; // por roomIndex
  /** Nomes de usuários (tipo 1) que passaram por esta sala, para dedupe. */
  seenUserIds: Set<number>;
  /** Mobis de chão por id (1778 na entrada; 1534/2703/3776 mantêm ao vivo). */
  floorItems: Map<number, FloorItem>;
  /** Mobis de parede por id (1369 na entrada). */
  wallItems: Map<string, WallItem>;
  /** Pintura: `floor`, `wallpaper`, `landscape` (2454). */
  paint: Record<string, string>;
  /** Planta (1301) e mapa de altura (2753) do quarto. */
  floorPlan: FloorPlan | null;
  heightMap: HeightMap | null;
  /** Casa da porta (1664; só chega a pedido, 3559). */
  door: { x: number; y: number; direction: number } | null;
  /** Casas ocupadas por mobi (3990; só chega a pedido, 1687). */
  occupiedTiles: { x: number; y: number }[] | null;
  /** Recebemos o 339: somos dono deste quarto. */
  isOwner: boolean;
}

function emptyRoom(id: number | null = null, enteredAt: number | null = null): RoomState {
  return { id, data: null, enteredAt, users: new Map(), seenUserIds: new Set(), floorItems: new Map(), wallItems: new Map(), paint: {}, floorPlan: null, heightMap: null, door: null, occupiedTiles: null, isOwner: false };
}

export type GameEvent =
  | { kind: 'me'; t: number; me: SelfInfo }
  | { kind: 'room-enter'; t: number; roomId: number | null; name?: string }
  /** Saímos do quarto. `reason` 'switching' = nós mesmos pedimos outro quarto há pouco; 'kicked' = expulsão (1600/4008) ou saída sem pedido nosso. */
  | { kind: 'room-leave'; t: number; roomId: number | null; name?: string; reason: 'switching' | 'kicked' }
  /** O servidor recusou a entrada no quarto pedido (899): 1 = cheio, 4 = banido. Ficamos na visão do hotel. */
  | { kind: 'room-enter-error'; t: number; roomId: number | null; reason: number }
  /** O servidor mandou o cliente para um quarto (resposta a "seguir amigo"). O cliente completa a entrada. */
  | { kind: 'room-forward'; t: number; roomId: number }
  | { kind: 'follow-sent'; t: number; userId: number; userName?: string }
  | { kind: 'walk-sent'; t: number; x: number; y: number }
  | { kind: 'user-enter'; t: number; user: RoomUser }
  | { kind: 'user-leave'; t: number; roomIndex: number; name?: string }
  | { kind: 'chat'; t: number; roomIndex: number; name?: string; text: string; shout: boolean; whisper: boolean }
  | { kind: 'friend-request'; t: number; request: FriendRequest }
  /** Alguém da sala foi respeitado (2815). `respects` = total dele depois deste. */
  | { kind: 'respect'; t: number; userId: number; name?: string; respects: number }
  /** Perfil pedido pelo nick chegou (3898): traz o visual mesmo com a pessoa offline. */
  | { kind: 'profile'; t: number; userId: number; name: string; figure: string; motto: string; online: boolean }
  /** O servidor aceitou a troca do nosso visual (2429). */
  | { kind: 'figure'; t: number; figure: string; gender: string }
  /** Pedido de entrada num grupo recusado (762). */
  | { kind: 'group-join-failed'; t: number; reason: number }
  | { kind: 'friend-added'; t: number; friend: Friend }
  | { kind: 'friend-removed'; t: number; id: number }
  | { kind: 'console'; t: number; senderId: number; senderName?: string; text: string; secondsSinceSent: number }
  | { kind: 'console-sent'; t: number; userId: number; userName?: string; text: string }
  | { kind: 'chat-sent'; t: number; text: string; whisperTo?: string }
  | { kind: 'friend-request-sent'; t: number; name: string }
  | { kind: 'friends-accepted-sent'; t: number; ids: number[] }
  | { kind: 'dialog'; t: number; strings: string[] }
  /** Aviso do servidor em janela (3801), ex.: planta salva. */
  | { kind: 'notice'; t: number; text: string }
  /** Compra aceita (869). */
  | { kind: 'purchase'; t: number; offerId: number; name: string }
  /** Itens novos no inventário (2103). */
  | { kind: 'unseen-items'; t: number; ids: number[] }
  /** Inventário completo recebido (último fragmento do 994). */
  | { kind: 'inventory'; t: number; count: number }
  | { kind: 'decode-error'; t: number; header: number; message: string };

export interface GameSnapshot {
  version: number;
  me: SelfInfo | null;
  friends: Friend[];
  friendsLoaded: boolean;
  pendingRequests: FriendRequest[];
  /** Nomes para os quais já enviamos 3157 nesta sessão (para não repetir). */
  requestedNames: Set<string>;
  room: {
    id: number | null;
    name: string | null;
    ownerName: string | null;
    enteredAt: number | null;
    users: RoomUserState[];
    /** Mobis de chão conhecidos (mesma referência enquanto nenhum mobi muda). */
    floorItems: FloorItem[];
    wallItems: WallItem[];
    paint: Record<string, string>;
    floorPlan: FloorPlan | null;
    heightMap: HeightMap | null;
    door: { x: number; y: number; direction: number } | null;
    occupiedTiles: { x: number; y: number }[] | null;
    isOwner: boolean;
  };
  /** Inventário de mobis (994), quando já pedido; mesma referência enquanto não muda. */
  inventory: InventoryItem[];
  inventoryLoaded: boolean;
  /** Índice do catálogo (1032), quando já pedido. */
  catalogIndex: CatalogNode[] | null;
  /** Páginas do catálogo já recebidas (804), por id. */
  catalogPages: ReadonlyMap<number, CatalogPage>;
  navigatorRooms: RoomData[];
  commands: { command: string; description: string }[];
  events: GameEvent[];
  decodeErrors: number;
  /** Último 2312 visto na saída (do cliente ou injetado): para saber se o cliente já pediu a entrada. */
  roomEnterSent: { roomId: number | null; t: number };
  /** Total de eventos já registrados na sessão. `events` guarda só os últimos EVENT_CAP; quem consome usa este contador como cursor. */
  eventSeq: number;
}

const EVENT_CAP = 600;

type Listener = () => void;

export class GameState {
  private version = 0;
  private me: SelfInfo | null = null;
  private friends = new Map<number, Friend>();
  private friendsLoaded = false;
  private pending = new Map<number, FriendRequest>();
  private requestedNames = new Set<string>();
  private room: RoomState = emptyRoom();
  private pendingRoomId: number | null = null;
  private lastRoomEnterSentAt = 0;
  /** Momento do último 1600/4008 ("você foi expulso"); classifica o 2661 próprio que vem logo depois. */
  private kickedAt = 0;
  private navigatorRooms: RoomData[] = [];
  private commands: { command: string; description: string }[] = [];
  private inventory = new Map<number, InventoryItem>();
  private inventoryLoaded = false;
  private inventoryVersion = 0;
  private inventoryCache: { version: number; list: InventoryItem[] } = { version: -1, list: [] };
  private catalogIndex: CatalogNode[] | null = null;
  /** ofertaId → páginaId, do índice. */
  private offerPage = new Map<number, number>();
  private catalogPages = new Map<number, CatalogPage>();
  private events: GameEvent[] = [];
  private eventSeq = 0;
  private decodeErrors = 0;
  private listeners = new Set<Listener>();
  private snapshotCache: GameSnapshot | null = null;
  /** Muda só quando um mobi entra, sai ou se move: a lista do snapshot é reaproveitada entre bumps. */
  private furniVersion = 0;
  private floorItemsCache: { version: number; list: FloorItem[] } = { version: -1, list: [] };
  private wallItemsCache: { version: number; list: WallItem[] } = { version: -1, list: [] };

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Versão monotônica: muda a cada alteração de estado. */
  getVersion(): number {
    return this.version;
  }

  reset(): void {
    this.me = null;
    this.friends.clear();
    this.friendsLoaded = false;
    this.pending.clear();
    this.requestedNames.clear();
    this.room = emptyRoom();
    this.pendingRoomId = null;
    this.lastRoomEnterSentAt = 0;
    this.kickedAt = 0;
    this.navigatorRooms = [];
    this.inventory.clear();
    this.inventoryLoaded = false;
    this.inventoryVersion++;
    this.events = [];
    this.eventSeq = 0;
    this.bump();
  }

  /** Página do catálogo que vende a oferta (pelo índice 1032), ou null se o índice não a lista. */
  pageForOffer(offerId: number): number | null {
    return this.offerPage.get(offerId) ?? null;
  }

  /** Marca localmente que pedimos amizade a alguém (chamado pela ação). */
  noteFriendRequestSent(name: string): void {
    this.requestedNames.add(name.toLowerCase());
    this.push({ kind: 'friend-request-sent', t: Date.now(), name });
  }

  noteAcceptSent(ids: number[]): void {
    for (const id of ids) this.pending.delete(id);
    this.push({ kind: 'friends-accepted-sent', t: Date.now(), ids });
  }

  /** Ponto de entrada: um pacote capturado (qualquer direção). */
  handle(p: ProtocolPacket): void {
    if (p.header < 0 || p.redacted) return;
    try {
      if (p.dir === 'out') this.handleOut(p);
      else this.handleIn(p);
    } catch (e) {
      this.decodeErrors++;
      this.push({ kind: 'decode-error', t: p.t, header: p.header, message: e instanceof Error ? e.message : String(e) });
    }
  }

  /* ------------------------------------ saída ------------------------------------ */

  private handleOut(p: ProtocolPacket): void {
    switch (p.header) {
      case OUT.ROOM_ENTER: {
        const r = this.reader(p);
        this.pendingRoomId = r.int32();
        this.lastRoomEnterSentAt = p.t;
        this.bump();
        break;
      }
      case OUT.REQUEST_FRIEND: {
        // Também cobre pedidos feitos pelo DOM: ficam registrados como "já pedidos".
        const r = this.reader(p);
        const name = r.string();
        if (!this.requestedNames.has(name.toLowerCase())) {
          this.requestedNames.add(name.toLowerCase());
          this.push({ kind: 'friend-request-sent', t: p.t, name });
        }
        break;
      }
      case OUT.CHAT: {
        const r = this.reader(p);
        this.push({ kind: 'chat-sent', t: p.t, text: r.string() });
        break;
      }
      case OUT.WHISPER: {
        const r = this.reader(p);
        const full = r.string();
        const sp = full.indexOf(' ');
        this.push({ kind: 'chat-sent', t: p.t, text: sp > 0 ? full.slice(sp + 1) : full, whisperTo: sp > 0 ? full.slice(0, sp) : full });
        break;
      }
      case OUT.FOLLOW_FRIEND: {
        const userId = this.reader(p).int32();
        this.push({ kind: 'follow-sent', t: p.t, userId, userName: this.friends.get(userId)?.name });
        break;
      }
      case OUT.WALK_TO: {
        const r = this.reader(p);
        this.push({ kind: 'walk-sent', t: p.t, x: r.int32(), y: r.int32() });
        break;
      }
      case OUT.CONSOLE_SEND: {
        const r = this.reader(p);
        const userId = r.int32();
        const text = r.string();
        this.push({ kind: 'console-sent', t: p.t, userId, userName: this.friends.get(userId)?.name, text });
        break;
      }
      case OUT.ACCEPT_FRIENDS: {
        const r = this.reader(p);
        const n = r.int32();
        const ids: number[] = [];
        for (let i = 0; i < n; i++) ids.push(r.int32());
        for (const id of ids) this.pending.delete(id);
        this.push({ kind: 'friends-accepted-sent', t: p.t, ids });
        break;
      }
    }
  }

  /* ------------------------------------ entrada ------------------------------------ */

  private handleIn(p: ProtocolPacket): void {
    switch (p.header) {
      case IN.USER_INFO: {
        this.me = parseSelfInfo(this.reader(p));
        this.push({ kind: 'me', t: p.t, me: this.me });
        break;
      }
      case IN.FRIENDS_LIST: {
        const frag = parseFriendsFragment(this.reader(p));
        if (frag.fragment === 0) this.friends.clear();
        for (const f of frag.friends) this.friends.set(f.id, f);
        if (frag.partial || p.truncated) {
          // Ficamos com o que coube. O agente já guarda até 4 MB por pacote; se ainda assim cortou, avisa.
          this.decodeErrors++;
          this.push({
            kind: 'decode-error',
            t: p.t,
            header: p.header,
            message: `lista de amigos truncada: ${frag.friends.length} de ${frag.declaredCount} lidos (corpo de ${p.bodyLength} bytes)`,
          });
        }
        if (frag.fragment >= frag.totalFragments - 1) this.friendsLoaded = true;
        this.bump();
        break;
      }
      case IN.FRIENDS_UPDATE: {
        const upd = parseFriendsUpdate(this.reader(p));
        for (const f of upd.upserted) {
          const isNew = !this.friends.has(f.id);
          this.friends.set(f.id, f);
          this.pending.delete(f.id);
          if (isNew && this.friendsLoaded) this.push({ kind: 'friend-added', t: p.t, friend: f });
        }
        for (const id of upd.removedIds) {
          this.friends.delete(id);
          this.push({ kind: 'friend-removed', t: p.t, id });
        }
        this.bump();
        break;
      }
      case IN.FRIEND_REQUEST: {
        const req = parseFriendRequest(this.reader(p));
        this.pending.set(req.requestId, req);
        this.push({ kind: 'friend-request', t: p.t, request: req });
        break;
      }
      case IN.RESPECT_RECEIVED: {
        const r = parseRespectReceived(this.reader(p));
        const name = [...this.room.users.values()].find((u) => u.id === r.userId)?.name;
        this.push({ kind: 'respect', t: p.t, userId: r.userId, name, respects: r.respects });
        break;
      }
      case IN.USER_PROFILE: {
        const pr = parseUserProfile(this.reader(p));
        this.push({ kind: 'profile', t: p.t, userId: pr.id, name: pr.name, figure: pr.figure, motto: pr.motto, online: pr.online });
        break;
      }
      case IN.USER_FIGURE: {
        const f = parseFigureUpdate(this.reader(p));
        if (this.me) this.me = { ...this.me, figure: f.figure, gender: f.gender };
        this.push({ kind: 'figure', t: p.t, figure: f.figure, gender: f.gender });
        break;
      }
      case IN.GROUP_JOIN_FAILED: {
        this.push({ kind: 'group-join-failed', t: p.t, reason: this.reader(p).int32() });
        break;
      }
      case IN.ROOM_READY: {
        this.room = emptyRoom(this.pendingRoomId, p.t);
        this.furniVersion++;
        this.push({ kind: 'room-enter', t: p.t, roomId: this.pendingRoomId ?? null });
        break;
      }
      case IN.ROOM_DATA: {
        const res = parseGuestRoomResult(this.reader(p));
        if (this.room.id === null || this.room.id === res.room.roomId) {
          this.room.id = res.room.roomId;
          this.room.data = res.room;
          this.bump();
        }
        break;
      }
      case IN.ROOM_USERS: {
        const users = parseRoomUsers(this.reader(p));
        for (const u of users) {
          const existing = this.room.users.get(u.roomIndex);
          this.room.users.set(u.roomIndex, {
            ...u,
            status: existing?.status ?? '',
            rights: existing?.rights ?? null,
            moveTarget: existing?.moveTarget ?? null,
            posture: existing?.posture ?? null,
            lastMoveAt: existing?.lastMoveAt ?? null,
            typing: false,
            idle: false,
            effectId: 0,
            enteredAt: existing?.enteredAt ?? p.t,
            lastChat: existing?.lastChat,
            nameTagHtml: existing?.nameTagHtml,
          });
          if (u.type === UNIT_TYPE.USER) this.room.seenUserIds.add(u.id);
          if (!existing) this.push({ kind: 'user-enter', t: p.t, user: u });
        }
        break;
      }
      case IN.UNIT_STATUS: {
        const statuses = parseUnitStatuses(this.reader(p));
        let changed = false;
        for (const s of statuses) {
          const u = this.room.users.get(s.roomIndex);
          if (!u) continue;
          u.x = s.x;
          u.y = s.y;
          u.z = s.z;
          u.direction = s.direction;
          u.status = s.actions;
          const info = parseUnitActions(s.actions);
          u.rights = info.rights ?? u.rights;
          u.moveTarget = info.moveTarget;
          u.posture = info.posture;
          if (info.moveTarget) u.lastMoveAt = p.t;
          changed = true;
        }
        if (changed) this.bump();
        break;
      }
      case IN.UNIT_REMOVE: {
        const idx = parseUnitRemove(this.reader(p));
        const u = this.room.users.get(idx);
        this.room.users.delete(idx);
        if (u && this.me && u.id === this.me.id) {
          // O removido sou eu: saí do quarto (troca pedida por nós, saída manual ou expulsão).
          this.leaveRoom(p.t);
        } else {
          this.push({ kind: 'user-leave', t: p.t, roomIndex: idx, name: u?.name });
        }
        break;
      }
      case IN.ROOM_FORWARD: {
        const roomId = parseRoomForward(this.reader(p));
        this.pendingRoomId = roomId;
        this.lastRoomEnterSentAt = p.t; // a saída que vem a seguir é uma troca, não expulsão
        this.push({ kind: 'room-forward', t: p.t, roomId });
        break;
      }
      case IN.HOTEL_VIEW: {
        if (this.room.id !== null || this.room.users.size > 0) this.leaveRoom(p.t);
        break;
      }
      case IN.GENERIC_ERROR: {
        const code = parseGenericError(this.reader(p));
        if (code === 4008) this.kickedAt = p.t;
        break;
      }
      case IN.ROOM_ENTER_ERROR: {
        const err = parseRoomEnterError(this.reader(p));
        const roomId = this.pendingRoomId;
        // Não vai chegar 758: o 2312 pendente morreu aqui. O 2661 próprio que vem junto é só a saída do quarto anterior.
        this.pendingRoomId = null;
        if (this.room.id !== null || this.room.users.size > 0) this.leaveRoom(p.t, 'switching');
        this.push({ kind: 'room-enter-error', t: p.t, roomId, reason: err.reason });
        break;
      }
      case IN.ROOM_FLOOR_ITEMS: {
        const res = parseFloorItems(this.reader(p));
        for (const it of res.items) this.room.floorItems.set(it.id, it);
        if (res.partial || p.truncated) {
          this.decodeErrors++;
          this.push({ kind: 'decode-error', t: p.t, header: p.header, message: `mobis de chão: ${res.items.length} de ${res.declaredCount} lidos (${res.error ?? 'corpo truncado'})` });
        }
        this.furniVersion++;
        this.bump();
        break;
      }
      case IN.ROOM_FLOOR_ITEM_ADD:
      case IN.ROOM_FLOOR_ITEM_UPDATE: {
        const it = p.header === IN.ROOM_FLOOR_ITEM_ADD ? parseFloorItemAdd(this.reader(p)) : parseFloorItem(this.reader(p));
        const prev = this.room.floorItems.get(it.id);
        if (prev && it.ownerName === undefined) it.ownerName = prev.ownerName;
        this.room.floorItems.set(it.id, it);
        this.furniVersion++;
        this.bump();
        break;
      }
      case IN.ROOM_WALL_ITEMS: {
        const res = parseWallItems(this.reader(p));
        for (const it of res.items) this.room.wallItems.set(it.id, it);
        if (res.partial || p.truncated) {
          this.decodeErrors++;
          this.push({ kind: 'decode-error', t: p.t, header: p.header, message: `mobis de parede: ${res.items.length} de ${res.declaredCount} lidos` });
        }
        this.furniVersion++;
        this.bump();
        break;
      }
      case IN.ROOM_PAINT: {
        const paint = parseRoomPaint(this.reader(p));
        this.room.paint = { ...this.room.paint, [paint.type]: paint.value };
        this.bump();
        break;
      }
      case IN.ROOM_FLOOR_PLAN: {
        this.room.floorPlan = parseFloorPlan(this.reader(p));
        this.bump();
        break;
      }
      case IN.ROOM_HEIGHT_MAP: {
        this.room.heightMap = parseHeightMap(this.reader(p));
        this.bump();
        break;
      }
      case IN.ROOM_ENTRY_TILE: {
        this.room.door = parseRoomEntryTile(this.reader(p));
        this.bump();
        break;
      }
      case IN.ROOM_OCCUPIED_TILES: {
        this.room.occupiedTiles = parseOccupiedTiles(this.reader(p));
        this.bump();
        break;
      }
      case IN.ROOM_RIGHTS_OWNER: {
        this.room.isOwner = true;
        this.bump();
        break;
      }
      case IN.ROOM_WALL_ITEM_ADD:
      case IN.ROOM_WALL_ITEM_UPDATE: {
        const it = parseWallItemAdd(this.reader(p));
        this.room.wallItems.set(it.id, it);
        this.furniVersion++;
        this.bump();
        break;
      }
      case IN.ROOM_WALL_ITEM_REMOVE: {
        const rm = parseWallItemRemove(this.reader(p));
        if (this.room.wallItems.delete(rm.id)) {
          this.furniVersion++;
          this.bump();
        }
        break;
      }
      case IN.OBJECT_DATA_UPDATE: {
        const upd = parseObjectDataUpdate(this.reader(p));
        const it = this.room.floorItems.get(upd.id);
        if (it) {
          this.room.floorItems.set(upd.id, { ...it, state: upd.state });
          this.furniVersion++;
          this.bump();
        }
        break;
      }
      case IN.SERVER_NOTICE: {
        this.push({ kind: 'notice', t: p.t, text: parseServerNotice(this.reader(p)).text });
        break;
      }
      case IN.CATALOG_INDEX: {
        const idx = parseCatalogIndex(this.reader(p));
        this.catalogIndex = idx.nodes;
        this.offerPage.clear();
        for (const n of idx.nodes) for (const o of n.offerIds) if (!this.offerPage.has(o)) this.offerPage.set(o, n.pageId);
        this.bump();
        break;
      }
      case IN.CATALOG_PAGE: {
        const page = parseCatalogPage(this.reader(p));
        this.catalogPages = new Map(this.catalogPages).set(page.pageId, page);
        this.bump();
        break;
      }
      case IN.PURCHASE_OK: {
        const ok = parsePurchaseOk(this.reader(p));
        this.push({ kind: 'purchase', t: p.t, offerId: ok.offerId, name: ok.name });
        break;
      }
      case IN.UNSEEN_ITEMS: {
        const ids = parseUnseenItems(this.reader(p)).flatMap((c) => c.ids);
        this.push({ kind: 'unseen-items', t: p.t, ids });
        break;
      }
      case IN.INVENTORY: {
        const frag = parseInventory(this.reader(p));
        if (frag.fragment === 0) this.inventory.clear();
        for (const it of frag.items) this.inventory.set(it.itemId, it);
        if (frag.partial || p.truncated) {
          this.decodeErrors++;
          this.push({ kind: 'decode-error', t: p.t, header: p.header, message: `inventário: ${frag.items.length} de ${frag.declaredCount} lidos` });
        }
        this.inventoryVersion++;
        if (frag.fragment >= frag.totalFragments - 1) {
          this.inventoryLoaded = true;
          this.push({ kind: 'inventory', t: p.t, count: this.inventory.size });
        }
        this.bump();
        break;
      }
      case IN.INVENTORY_REMOVE: {
        const id = this.reader(p).int32();
        if (this.inventory.delete(id)) {
          this.inventoryVersion++;
          this.bump();
        }
        break;
      }
      case IN.ROOM_FLOOR_ITEM_REMOVE: {
        const rm = parseFloorItemRemove(this.reader(p));
        if (this.room.floorItems.delete(rm.id)) {
          this.furniVersion++;
          this.bump();
        }
        break;
      }
      case IN.UNIT_INFO: {
        const info = parseUnitInfo(this.reader(p));
        const u = this.room.users.get(info.roomIndex);
        if (u) {
          u.figure = info.figure;
          u.motto = info.motto;
          u.sex = info.sex;
          this.bump();
        }
        break;
      }
      case IN.UNIT_TYPING: {
        const t = parseTyping(this.reader(p));
        const u = this.room.users.get(t.roomIndex);
        if (u) {
          u.typing = t.typing;
          this.bump();
        }
        break;
      }
      case IN.UNIT_IDLE: {
        const t = parseIdle(this.reader(p));
        const u = this.room.users.get(t.roomIndex);
        if (u) {
          u.idle = t.idle;
          this.bump();
        }
        break;
      }
      case IN.UNIT_EFFECT: {
        const e = parseEffect(this.reader(p));
        const u = this.room.users.get(e.roomIndex);
        if (u) {
          u.effectId = e.effectId;
          this.bump();
        }
        break;
      }
      case IN.CHAT:
      case IN.SHOUT:
      case IN.WHISPER: {
        const c = parseChat(this.reader(p));
        const u = this.room.users.get(c.roomIndex);
        if (u) u.lastChat = { text: c.message, t: p.t };
        this.push({
          kind: 'chat',
          t: p.t,
          roomIndex: c.roomIndex,
          name: u?.name,
          text: c.message,
          shout: p.header === IN.SHOUT,
          whisper: p.header === IN.WHISPER,
        });
        break;
      }
      case IN.CONSOLE_MESSAGE: {
        const m = parseConsoleMessage(this.reader(p));
        this.push({ kind: 'console', t: p.t, senderId: m.senderId, senderName: this.friends.get(m.senderId)?.name, text: m.message, secondsSinceSent: m.secondsSinceSent });
        break;
      }
      case IN.HABBLET_NAME_TAG: {
        const tag = parseNameTag(this.reader(p));
        const u = this.room.users.get(tag.roomIndex);
        if (u) {
          u.nameTagHtml = tag.html;
          this.bump();
        }
        break;
      }
      case IN.NAVIGATOR_RESULTS: {
        const res = parseNavigatorResults(this.reader(p));
        const rooms: RoomData[] = [];
        const seen = new Set<number>();
        for (const b of res.blocks) for (const r of b.rooms) if (!seen.has(r.roomId)) { seen.add(r.roomId); rooms.push(r); }
        this.navigatorRooms = rooms;
        this.bump();
        break;
      }
      case IN.SERVER_DIALOG: {
        const d = parseServerDialog(base64ToBytes(p.body));
        this.push({ kind: 'dialog', t: p.t, strings: d.strings });
        break;
      }
      case IN.HABBLET_COMMANDS: {
        this.commands = parseHabbletCommands(base64ToBytes(p.body));
        this.bump();
        break;
      }
    }
  }

  private leaveRoom(t: number, forced?: 'switching' | 'kicked'): void {
    const kicked = this.kickedAt > 0 && t - this.kickedAt < 2000;
    const reason: 'switching' | 'kicked' = forced ?? (kicked || t - this.lastRoomEnterSentAt >= 5000 ? 'kicked' : 'switching');
    if (kicked) this.kickedAt = 0;
    const roomId = this.room.id;
    const name = this.room.data?.name;
    this.room = emptyRoom();
    this.furniVersion++;
    this.push({ kind: 'room-leave', t, roomId, name, reason });
  }

  /** true quando estamos dentro de um quarto (já recebemos o 758 e ainda não saímos). */
  get inRoom(): boolean {
    return this.room.id !== null || this.room.users.size > 0;
  }

  /* ------------------------------------ consulta ------------------------------------ */

  /** Usuários (tipo 1) na sala, exceto eu, amigos e já pedidos — candidatos a pedido de amizade. */
  friendRequestCandidates(ignoreNames: string[] = []): RoomUserState[] {
    const ignore = new Set(ignoreNames.map((n) => n.toLowerCase()));
    const friendIds = new Set(this.friends.keys());
    const out: RoomUserState[] = [];
    for (const u of this.room.users.values()) {
      if (u.type !== UNIT_TYPE.USER) continue;
      if (this.me && u.id === this.me.id) continue;
      if (friendIds.has(u.id)) continue;
      const lower = u.name.toLowerCase();
      if (ignore.has(lower) || this.requestedNames.has(lower)) continue;
      out.push(u);
    }
    return out;
  }

  isFriend(userId: number): boolean {
    return this.friends.has(userId);
  }

  snapshot(): GameSnapshot {
    if (this.snapshotCache && this.snapshotCache.version === this.version) return this.snapshotCache;
    const users = [...this.room.users.values()].sort((a, b) => a.enteredAt - b.enteredAt);
    this.snapshotCache = {
      version: this.version,
      me: this.me,
      friends: [...this.friends.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
      friendsLoaded: this.friendsLoaded,
      pendingRequests: [...this.pending.values()],
      requestedNames: this.requestedNames,
      room: {
        id: this.room.id,
        name: this.room.data?.name ?? null,
        ownerName: this.room.data?.ownerName ?? null,
        enteredAt: this.room.enteredAt,
        users,
        floorItems: this.floorItemsList(),
        wallItems: this.wallItemsList(),
        paint: this.room.paint,
        floorPlan: this.room.floorPlan,
        heightMap: this.room.heightMap,
        door: this.room.door,
        occupiedTiles: this.room.occupiedTiles,
        isOwner: this.room.isOwner,
      },
      inventory: this.inventoryList(),
      inventoryLoaded: this.inventoryLoaded,
      catalogIndex: this.catalogIndex,
      catalogPages: this.catalogPages,
      navigatorRooms: this.navigatorRooms,
      commands: this.commands,
      events: this.events,
      decodeErrors: this.decodeErrors,
      roomEnterSent: { roomId: this.pendingRoomId, t: this.lastRoomEnterSentAt },
      eventSeq: this.eventSeq,
    };
    return this.snapshotCache;
  }

  /** Quantos mobis de chão o quarto tem (sem montar a lista). */
  get floorItemCount(): number {
    return this.room.floorItems.size;
  }

  /* ------------------------------------ interno ------------------------------------ */

  private inventoryList(): InventoryItem[] {
    if (this.inventoryCache.version !== this.inventoryVersion) {
      this.inventoryCache = { version: this.inventoryVersion, list: [...this.inventory.values()] };
    }
    return this.inventoryCache.list;
  }

  private wallItemsList(): WallItem[] {
    if (this.wallItemsCache.version !== this.furniVersion) {
      this.wallItemsCache = { version: this.furniVersion, list: [...this.room.wallItems.values()] };
    }
    return this.wallItemsCache.list;
  }

  private floorItemsList(): FloorItem[] {
    if (this.floorItemsCache.version !== this.furniVersion) {
      this.floorItemsCache = { version: this.furniVersion, list: [...this.room.floorItems.values()] };
    }
    return this.floorItemsCache.list;
  }

  private reader(p: ProtocolPacket): PacketReader {
    return new PacketReader(base64ToBytes(p.body));
  }

  private push(ev: GameEvent): void {
    this.events.push(ev);
    this.eventSeq++;
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
    this.bump();
  }

  private bump(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
}
