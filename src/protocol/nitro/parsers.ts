/**
 * Decodificadores tipados dos pacotes de entrada confirmados em captura.
 * Estruturas seguem os parsers do Nitro (release PRODUCTION-202101271337); onde a
 * captura mostrou diferença, prevalece a captura. Cada função recebe um PacketReader
 * posicionado no início do corpo e pode lançar em corpo inesperado — quem chama trata.
 */
import { PacketReader, extractStrings } from '../decode';
import { UNIT_TYPE } from './headers';

/* ------------------------------------ usuário ------------------------------------ */

export interface SelfInfo {
  id: number;
  name: string;
  figure: string;
  gender: string;
  motto: string;
  realName: string;
  respectsReceived: number;
  respectsLeft: number;
}

/** IN 2725 */
export function parseSelfInfo(r: PacketReader): SelfInfo {
  const id = r.int32();
  const name = r.string();
  const figure = r.string();
  const gender = r.string();
  const motto = r.string();
  const realName = r.string();
  r.boolean(); // directMail
  const respectsReceived = r.int32();
  r.int32(); // respectsPetLeft
  const respectsLeft = r.int32();
  return { id, name, figure, gender, motto, realName, respectsReceived, respectsLeft };
}

/* ------------------------------------ amigos ------------------------------------ */

export interface Friend {
  id: number;
  name: string;
  gender: number;
  online: boolean;
  followingAllowed: boolean;
  figure: string;
  categoryId: number;
  motto: string;
  realName: string;
  vipMember: boolean;
  relationshipStatus: number;
}

function parseFriend(r: PacketReader): Friend {
  const id = r.int32();
  const name = r.string();
  const gender = r.int32();
  const online = r.boolean();
  const followingAllowed = r.boolean();
  const figure = r.string();
  const categoryId = r.int32();
  const motto = r.string();
  const realName = r.string();
  r.string(); // facebookId
  r.boolean(); // persistedMessageUser
  const vipMember = r.boolean();
  r.boolean(); // pocketHabboUser
  const relationshipStatus = r.remaining >= 2 ? r.int16() : 0;
  return { id, name, gender, online, followingAllowed, figure, categoryId, motto, realName, vipMember, relationshipStatus };
}

export interface FriendsFragment {
  totalFragments: number;
  fragment: number;
  /** Quantos amigos o pacote declarou (`friends.length` é menor quando `partial`). */
  declaredCount: number;
  friends: Friend[];
  /** true quando o corpo acabou antes do último amigo (pacote truncado pelo agente). */
  partial: boolean;
}

/**
 * IN 3130. Tolerante a corpo truncado: uma conta com ~6 mil amigos gera um 3130 de 337 KB+, e se o agente
 * cortar o corpo ficamos com os amigos que couberam em vez de perder a lista inteira.
 */
export function parseFriendsFragment(r: PacketReader): FriendsFragment {
  const totalFragments = r.int32();
  const fragment = r.int32();
  const declaredCount = r.int32();
  const friends: Friend[] = [];
  let partial = false;
  for (let i = 0; i < declaredCount; i++) {
    try {
      friends.push(parseFriend(r));
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      partial = true;
      break;
    }
  }
  return { totalFragments, fragment, declaredCount, friends, partial };
}

export interface FriendsUpdate {
  categories: { id: number; name: string }[];
  /** Tipo 1 no Nitro. Neste hotel novos amigos chegam como tipo 0, então trate `upserted` como fonte da verdade. */
  added: Friend[];
  updated: Friend[];
  /** added + updated, na ordem do pacote. */
  upserted: Friend[];
  removedIds: number[];
}

/** IN 2800 */
export function parseFriendsUpdate(r: PacketReader): FriendsUpdate {
  const catCount = r.int32();
  const categories: FriendsUpdate['categories'] = [];
  for (let i = 0; i < catCount; i++) categories.push({ id: r.int32(), name: r.string() });
  const count = r.int32();
  const added: Friend[] = [];
  const updated: Friend[] = [];
  const upserted: Friend[] = [];
  const removedIds: number[] = [];
  for (let i = 0; i < count; i++) {
    const type = r.int32();
    if (type === -1) {
      removedIds.push(r.int32());
    } else {
      const f = parseFriend(r);
      (type === 1 ? added : updated).push(f);
      upserted.push(f);
    }
  }
  return { categories, added, updated, upserted, removedIds };
}

export interface FriendRequest {
  /** Neste hotel é o id do usuário que pediu (é o que o ACCEPT_FRIENDS usa). */
  requestId: number;
  name: string;
  figure: string;
}

/** IN 2219 */
export function parseFriendRequest(r: PacketReader): FriendRequest {
  return { requestId: r.int32(), name: r.string(), figure: r.string() };
}

export interface RespectReceived {
  userId: number;
  /** Total de respeitos que o usuário tem depois deste. */
  respects: number;
}

/** IN 2815 — alguém da sala foi respeitado. */
export function parseRespectReceived(r: PacketReader): RespectReceived {
  return { userId: r.int32(), respects: r.int32() };
}

export interface UserProfile {
  id: number;
  name: string;
  figure: string;
  motto: string;
  /** Data de criação como o servidor manda (texto). */
  createdAt: string;
  achievementScore: number;
  friendCount: number;
  isFriend: boolean;
  online: boolean;
}

/** IN 3898 — perfil de um usuário (só o começo; grupos e o resto não interessam). */
export function parseUserProfile(r: PacketReader): UserProfile {
  const id = r.int32();
  const name = r.string();
  const figure = r.string();
  const motto = r.string();
  const createdAt = r.string();
  const achievementScore = r.int32();
  const friendCount = r.int32();
  const isFriend = r.boolean();
  r.boolean(); // pedido de amizade já enviado
  const online = r.boolean();
  return { id, name, figure, motto, createdAt, achievementScore, friendCount, isFriend, online };
}

/** IN 2429 — o servidor aceitou a troca do nosso visual. */
export function parseFigureUpdate(r: PacketReader): { figure: string; gender: string } {
  return { figure: r.string(), gender: r.string() };
}

export interface UserBadges {
  userId: number;
  badges: { slot: number; code: string }[];
}

/** IN 1087 */
export function parseUserBadges(r: PacketReader): UserBadges {
  const userId = r.int32();
  const count = r.int32();
  const badges: UserBadges['badges'] = [];
  for (let i = 0; i < count; i++) badges.push({ slot: r.int32(), code: r.string() });
  return { userId, badges };
}

export interface Relationships {
  userId: number;
  items: { type: number; friendCount: number; friendId: number; friendName: string; friendFigure: string }[];
}

/** IN 2016 */
export function parseRelationships(r: PacketReader): Relationships {
  const userId = r.int32();
  const count = r.int32();
  const items: Relationships['items'] = [];
  for (let i = 0; i < count; i++) {
    items.push({ type: r.int32(), friendCount: r.int32(), friendId: r.int32(), friendName: r.string(), friendFigure: r.string() });
  }
  return { userId, items };
}

/* ------------------------------------- sala ------------------------------------- */

export interface RoomUser {
  id: number;
  name: string;
  motto: string;
  figure: string;
  roomIndex: number;
  x: number;
  y: number;
  z: number;
  direction: number;
  /** 1 usuário, 2 pet, 3 bot, 4 bot alugável. */
  type: number;
  sex?: string;
  groupId?: number;
  groupName?: string;
  achievementScore?: number;
  isModerator?: boolean;
}

/** IN 374 */
export function parseRoomUsers(r: PacketReader): RoomUser[] {
  const count = r.int32();
  const out: RoomUser[] = [];
  for (let i = 0; i < count; i++) {
    const u: RoomUser = {
      id: r.int32(),
      name: r.string(),
      motto: r.string(),
      figure: r.string(),
      roomIndex: r.int32(),
      x: r.int32(),
      y: r.int32(),
      z: parseFloat(r.string()),
      direction: r.int32(),
      type: r.int32(),
    };
    if (u.type === UNIT_TYPE.USER) {
      u.sex = r.string();
      u.groupId = r.int32();
      r.int32(); // groupStatus
      u.groupName = r.string();
      r.string(); // swimFigure
      u.achievementScore = r.int32();
      u.isModerator = r.boolean();
    } else if (u.type === UNIT_TYPE.PET) {
      r.int32(); // subType
      r.int32(); // ownerId
      r.string(); // ownerName
      r.int32(); // rarity
      r.boolean(); r.boolean(); r.boolean(); r.boolean(); r.boolean(); r.boolean();
      r.int32(); // level
      r.string(); // posture
    } else if (u.type === UNIT_TYPE.RENTABLE_BOT) {
      r.string(); // sex
      r.int32(); // ownerId
      r.string(); // ownerName
      const skills = r.int32();
      for (let s = 0; s < skills; s++) r.int16();
    }
    out.push(u);
  }
  return out;
}

export interface UnitStatus {
  roomIndex: number;
  x: number;
  y: number;
  z: number;
  headDirection: number;
  direction: number;
  /** Ex.: `/flatctrl 0/mv 31,31,0.0//`, `/sit 0.5/`. */
  actions: string;
}

/** IN 1640 */
export function parseUnitStatuses(r: PacketReader): UnitStatus[] {
  const count = r.int32();
  const out: UnitStatus[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      roomIndex: r.int32(),
      x: r.int32(),
      y: r.int32(),
      z: parseFloat(r.string()),
      headDirection: r.int32(),
      direction: r.int32(),
      actions: r.string(),
    });
  }
  return out;
}

export interface UnitStatusInfo {
  /** Nível de direitos no quarto: 0 nenhum, 1 direitos, 4 dono (`/flatctrl N`). */
  rights: number | null;
  /** Alvo do próximo passo (`/mv x,y,z`) — presente só enquanto anda. */
  moveTarget: { x: number; y: number; z: number } | null;
  /** `sit` / `lay` (com altura) ou null em pé. */
  posture: 'sit' | 'lay' | null;
  /** Outras ações presentes (ex.: `wav`, `dance`, `sign 3`). */
  actions: string[];
}

/**
 * Gramática observada do campo `actions` do 1640: sequência de `/chave [args]` terminada em `//`.
 * Ex.: `/flatctrl 4/mv 7,10,0.0//`, `/sit 0.5//`, `/flatctrl 0//`.
 */
export function parseUnitActions(actions: string): UnitStatusInfo {
  const info: UnitStatusInfo = { rights: null, moveTarget: null, posture: null, actions: [] };
  for (const raw of actions.split('/')) {
    const part = raw.trim();
    if (!part) continue;
    const sp = part.indexOf(' ');
    const key = sp > 0 ? part.slice(0, sp) : part;
    const arg = sp > 0 ? part.slice(sp + 1).trim() : '';
    if (key === 'flatctrl') info.rights = parseInt(arg, 10) || 0;
    else if (key === 'mv') {
      const [x, y, z] = arg.split(',');
      info.moveTarget = { x: parseInt(x, 10), y: parseInt(y, 10), z: parseFloat(z) || 0 };
    } else if (key === 'sit' || key === 'lay') info.posture = key;
    else info.actions.push(arg ? `${key} ${arg}` : key);
  }
  return info;
}

/** IN 160 — o servidor manda o cliente para um quarto. */
export function parseRoomForward(r: PacketReader): number {
  return r.int32();
}

/** IN 1600 — código do erro genérico (4008 = expulso do quarto). */
export function parseGenericError(r: PacketReader): number {
  return r.int32();
}

/** Motivos do 899 (RoomEnterError). */
export const ROOM_ENTER_ERROR_REASON = { FULL: 1, BANNED: 4 } as const;

/** IN 899 — entrada no quarto recusada. */
export function parseRoomEnterError(r: PacketReader): { reason: number; parameter: string } {
  const reason = r.int32();
  const parameter = r.remaining >= 2 ? r.string() : '';
  return { reason, parameter };
}

/** IN 2661 — devolve o roomIndex removido. */
export function parseUnitRemove(r: PacketReader): number {
  return parseInt(r.string(), 10);
}

export interface UnitInfo {
  roomIndex: number;
  figure: string;
  sex: string;
  motto: string;
  achievementScore: number;
}

/** IN 3920 */
export function parseUnitInfo(r: PacketReader): UnitInfo {
  return { roomIndex: r.int32(), figure: r.string(), sex: r.string(), motto: r.string(), achievementScore: r.int32() };
}

export interface ChatMessage {
  roomIndex: number;
  message: string;
  gesture: number;
  styleId: number;
  links: { url: string; text: string; internal: boolean }[];
  trackingId: number;
}

/** IN 1446 / 1036 / 2704 */
export function parseChat(r: PacketReader): ChatMessage {
  const roomIndex = r.int32();
  const message = r.string();
  const gesture = r.int32();
  const styleId = r.int32();
  const links: ChatMessage['links'] = [];
  if (r.remaining >= 4) {
    const n = r.int32();
    for (let i = 0; i < n && r.remaining > 0; i++) links.push({ url: r.string(), text: r.string(), internal: r.boolean() });
  }
  const trackingId = r.remaining >= 4 ? r.int32() : 0;
  return { roomIndex, message, gesture, styleId, links, trackingId };
}

/** IN 1717 */
export function parseTyping(r: PacketReader): { roomIndex: number; typing: boolean } {
  return { roomIndex: r.int32(), typing: r.int32() !== 0 };
}

/** IN 1797 */
export function parseIdle(r: PacketReader): { roomIndex: number; idle: boolean } {
  return { roomIndex: r.int32(), idle: r.boolean() };
}

/** IN 1167 */
export function parseEffect(r: PacketReader): { roomIndex: number; effectId: number; delay: number } {
  return { roomIndex: r.int32(), effectId: r.int32(), delay: r.int32() };
}

/** IN 2182 (custom Habblet) */
export function parseNameTag(r: PacketReader): { userId: number; roomIndex: number; html: string } {
  return { userId: r.int32(), roomIndex: r.int32(), html: r.string() };
}

export interface ConsoleMessage {
  senderId: number;
  message: string;
  secondsSinceSent: number;
}

/** IN 1587 */
export function parseConsoleMessage(r: PacketReader): ConsoleMessage {
  const senderId = r.int32();
  const message = r.string();
  const secondsSinceSent = r.remaining >= 4 ? r.int32() : 0;
  return { senderId, message, secondsSinceSent };
}

/* ------------------------------------ mobis de chão ------------------------------------ */

export interface FloorItem {
  id: number;
  /** `id` do furnidata (tipo do mobi). Negativo = classe estática (`staticClass`). */
  spriteId: number;
  x: number;
  y: number;
  /** 0, 2, 4 ou 6 (múltiplos de 90°); 2 e 6 = mobi girado (largura e profundidade trocam). */
  direction: number;
  z: number;
  /** Altura que o mobi acrescenta a quem fica em cima (`stackHeight`). */
  stackHeight: number;
  extra: number;
  /** Tipo dos dados extras (`tipoDados & 0xFF`): 0 legado (string), 1 mapa, 2 strings, 3 voto, 4 vazio, 5 números, 6 placar, 7 quebrável. */
  dataKind: number;
  /** Estado legado (`dataKind` 0): "0"/"1"/… — o que o cliente usa para animações e interação. */
  state: string;
  expires: number;
  usagePolicy: number;
  ownerId: number;
  ownerName?: string;
  staticClass?: string;
}

/**
 * Dados extras do mobi (ObjectData do Nitro). Só o kind 0 interessa (estado); os demais são pulados na
 * estrutura certa para o leitor ficar alinhado no próximo mobi. Kind 6 (placar) é a variante do Habblet
 * observada em 20/09/2026: `string estado`, `string título`, `int32`, `string coluna1`, `string coluna2`,
 * `int32 tipoPontuação`, `int32 tipoLimpeza`, `int32 n`, por linha: `int32`, `int32 pontos`, `int32 nUsuários`, strings.
 * Bit 0x100 do tipo (flags) = edição limitada: `int32 número`, `int32 série` no fim.
 */
function skipObjectData(r: PacketReader, type: number): string {
  const kind = type & 0xff;
  const flags = type >> 8;
  let state = '';
  switch (kind) {
    case 0:
      state = r.string();
      break;
    case 1: {
      const n = r.int32();
      for (let i = 0; i < n; i++) {
        const k = r.string();
        const v = r.string();
        if (k === 'state') state = v;
      }
      break;
    }
    case 2: {
      const n = r.int32();
      for (let i = 0; i < n; i++) {
        const v = r.string();
        if (i === 0) state = v;
      }
      break;
    }
    case 3:
      state = r.string();
      r.int32();
      break;
    case 4:
      break;
    case 5: {
      const n = r.int32();
      for (let i = 0; i < n; i++) {
        const v = r.int32();
        if (i === 0) state = String(v);
      }
      break;
    }
    case 6: {
      state = r.string();
      r.string(); // título
      r.int32();
      r.string(); // coluna 1
      r.string(); // coluna 2
      r.int32(); // scoreType
      r.int32(); // clearType
      const n = r.int32();
      for (let i = 0; i < n; i++) {
        r.int32();
        r.int32(); // pontos
        const users = r.int32();
        for (let j = 0; j < users; j++) r.string();
      }
      break;
    }
    case 7:
      state = r.string();
      r.int32(); // hits
      r.int32(); // target
      break;
    default:
      throw new Error(`dados de mobi de tipo desconhecido (${kind})`);
  }
  if (flags & 0x1) {
    r.int32(); // uniqueNumber
    r.int32(); // uniqueSeries
  }
  return state;
}

/** Um mobi de chão (FurnitureFloorDataParser). Usado pelo 1778, 1534 e 3776. */
export function parseFloorItem(r: PacketReader): FloorItem {
  const id = r.int32();
  const spriteId = r.int32();
  const x = r.int32();
  const y = r.int32();
  const direction = r.int32();
  const z = parseFloat(r.string()) || 0;
  const stackHeight = parseFloat(r.string()) || 0;
  const extra = r.int32();
  const type = r.int32();
  const state = skipObjectData(r, type);
  const expires = r.int32();
  const usagePolicy = r.int32();
  const ownerId = r.int32();
  const item: FloorItem = { id, spriteId, x, y, direction, z, stackHeight, extra, dataKind: type & 0xff, state, expires, usagePolicy, ownerId };
  if (spriteId < 0) item.staticClass = r.string();
  return item;
}

export interface FloorItems {
  /** Quantos mobis o pacote declarou (`items.length` é menor quando `partial`). */
  declaredCount: number;
  items: FloorItem[];
  /** true quando um mobi não pôde ser lido (corpo truncado ou dado inesperado): ficamos com os anteriores. */
  partial: boolean;
  error?: string;
}

/** IN 1778 — mobis de chão do quarto. Tolerante: um mobi com dado estranho não derruba a lista inteira. */
export function parseFloorItems(r: PacketReader): FloorItems {
  const ownerCount = r.int32();
  const owners = new Map<number, string>();
  for (let i = 0; i < ownerCount; i++) owners.set(r.int32(), r.string());
  const declaredCount = r.int32();
  const items: FloorItem[] = [];
  let partial = false;
  let error: string | undefined;
  for (let i = 0; i < declaredCount; i++) {
    try {
      const it = parseFloorItem(r);
      const owner = owners.get(it.ownerId);
      if (owner !== undefined) it.ownerName = owner;
      items.push(it);
    } catch (e) {
      partial = true;
      error = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  return { declaredCount, items, partial, error };
}

/** IN 1534 — mobi de chão colocado: um mobi + `string donoNome`. */
export function parseFloorItemAdd(r: PacketReader): FloorItem {
  const it = parseFloorItem(r);
  if (r.remaining >= 2) it.ownerName = r.string();
  return it;
}

/** IN 2703 — mobi de chão removido. O id vem como string. */
export function parseFloorItemRemove(r: PacketReader): { id: number; expired: boolean; pickerId: number; delay: number } {
  const id = parseInt(r.string(), 10);
  const expired = r.boolean();
  const pickerId = r.int32();
  const delay = r.remaining >= 4 ? r.int32() : 0;
  return { id, expired, pickerId, delay };
}

/* ------------------------------------ mobis de parede e planta ------------------------------------ */

export interface WallItem {
  /** Vem como string no protocolo. */
  id: string;
  spriteId: number;
  /** Posição na parede, no formato do cliente: `:w=x,y l=x,y l` (l/r = parede esquerda/direita). */
  wallPosition: string;
  state: string;
  expires: number;
  usagePolicy: number;
  ownerId: number;
  ownerName?: string;
}

/** IN 1369 — mobis de parede do quarto. */
export function parseWallItems(r: PacketReader): { items: WallItem[]; declaredCount: number; partial: boolean } {
  const ownerCount = r.int32();
  const owners = new Map<number, string>();
  for (let i = 0; i < ownerCount; i++) owners.set(r.int32(), r.string());
  const declaredCount = r.int32();
  const items: WallItem[] = [];
  let partial = false;
  for (let i = 0; i < declaredCount; i++) {
    try {
      const it: WallItem = { id: r.string(), spriteId: r.int32(), wallPosition: r.string(), state: r.string(), expires: r.int32(), usagePolicy: r.int32(), ownerId: r.int32() };
      const owner = owners.get(it.ownerId);
      if (owner !== undefined) it.ownerName = owner;
      items.push(it);
    } catch {
      partial = true;
      break;
    }
  }
  return { items, declaredCount, partial };
}

export interface RoomPaint {
  /** `floor`, `wallpaper` ou `landscape`. */
  type: string;
  value: string;
}

/** IN 2454 — uma das pinturas do quarto (chega um pacote por tipo). */
export function parseRoomPaint(r: PacketReader): RoomPaint {
  return { type: r.string(), value: r.string() };
}

export interface FloorPlanArea {
  id: number;
  flag: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloorPlan {
  zoomedIn: boolean;
  /** -1 = altura padrão da parede. */
  wallHeight: number;
  /** Uma linha por y; um caractere por casa: `x` = sem chão, `0`–`9`/`a`–`z` = altura do piso. */
  rows: string[];
  /** Extensão do Habblet no fim do pacote (id de mobi, flag e um retângulo); significado a confirmar. */
  areas: FloorPlanArea[];
}

/** Altura do piso de um caractere da planta; null para `x` (sem chão). */
export function floorPlanHeight(ch: string): number | null {
  if (ch === 'x' || ch === 'X' || ch === '') return null;
  const v = parseInt(ch, 36);
  return Number.isNaN(v) ? null : v;
}

/** IN 1301 — planta do quarto. */
export function parseFloorPlan(r: PacketReader): FloorPlan {
  const zoomedIn = r.boolean();
  const wallHeight = r.int32();
  const rows = r.string().split('\r').filter((row, i, all) => row.length > 0 || i < all.length - 1);
  const areas: FloorPlanArea[] = [];
  if (r.remaining >= 4) {
    const n = r.int32();
    for (let i = 0; i < n && r.remaining >= 21; i++) areas.push({ id: r.int32(), flag: r.boolean(), x: r.int32(), y: r.int32(), w: r.int32(), h: r.int32() });
  }
  return { zoomedIn, wallHeight, rows, areas };
}

export interface HeightMap {
  width: number;
  height: number;
  /** Altura do topo de cada casa (piso + mobis), por índice y * width + x; null = sem chão. */
  heights: (number | null)[];
  /** Casas onde não dá para empilhar (bit 0x4000). */
  stackingBlocked: boolean[];
}

/** IN 2753 — mapa de altura do topo das casas. */
export function parseHeightMap(r: PacketReader): HeightMap {
  const width = r.int32();
  const count = r.int32();
  const heights: (number | null)[] = [];
  const stackingBlocked: boolean[] = [];
  for (let i = 0; i < count; i++) {
    const v = r.int16();
    const noFloor = v === 0x3f3f || v < 0;
    heights.push(noFloor ? null : (v & 0x3fff) / 256);
    stackingBlocked.push((v & 0x4000) !== 0);
  }
  return { width, height: width > 0 ? Math.round(count / width) : 0, heights, stackingBlocked };
}

/** IN 1664 — casa da porta. */
export function parseRoomEntryTile(r: PacketReader): { x: number; y: number; direction: number } {
  return { x: r.int32(), y: r.int32(), direction: r.int32() };
}

/** IN 3990 — casas ocupadas por mobi. */
export function parseOccupiedTiles(r: PacketReader): { x: number; y: number }[] {
  const n = r.int32();
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) out.push({ x: r.int32(), y: r.int32() });
  return out;
}

/* ------------------------------------ catálogo e inventário ------------------------------------ */

/** IN 2187 / 2009 — um mobi de parede + `string donoNome`. */
export function parseWallItemAdd(r: PacketReader): WallItem {
  const it: WallItem = { id: r.string(), spriteId: r.int32(), wallPosition: r.string(), state: r.string(), expires: r.int32(), usagePolicy: r.int32(), ownerId: r.int32() };
  if (r.remaining >= 2) it.ownerName = r.string();
  return it;
}

/** IN 3208 — mobi de parede removido (id como string). */
export function parseWallItemRemove(r: PacketReader): { id: string } {
  return { id: r.string() };
}

/** IN 2547 — estado de um mobi de chão mudou: `string id`, dados do mobi (o estado é o primeiro campo). */
export function parseObjectDataUpdate(r: PacketReader): { id: number; state: string } {
  const id = parseInt(r.string(), 10);
  const type = r.int32();
  const state = skipObjectData(r, type);
  return { id, state };
}

/** IN 3801 — aviso do servidor: a primeira string é o texto. */
export function parseServerNotice(r: PacketReader): { text: string } {
  return { text: r.string() };
}

export interface CatalogNode {
  pageId: number;
  name: string;
  localization: string;
  icon: number;
  visible: boolean;
  depth: number;
  offerIds: number[];
}

/** IN 1032 — índice do catálogo, achatado (a árvore vira lista com `depth`). */
export function parseCatalogIndex(r: PacketReader): { nodes: CatalogNode[]; catalogType: string } {
  const nodes: CatalogNode[] = [];
  const walk = (depth: number) => {
    const visible = r.boolean();
    const icon = r.int32();
    const pageId = r.int32();
    const name = r.string();
    const localization = r.string();
    const nOffers = r.int32();
    const offerIds: number[] = [];
    for (let i = 0; i < nOffers; i++) offerIds.push(r.int32());
    const children = r.int32();
    nodes.push({ pageId, name, localization, icon, visible, depth, offerIds });
    for (let i = 0; i < children; i++) walk(depth + 1);
  };
  walk(0);
  const catalogType = r.remaining >= 2 ? r.string() : '';
  return { nodes, catalogType };
}

export interface CatalogProduct {
  /** `s` mobi de chão, `i` mobi de parede, `e` efeito, `b` emblema. */
  type: string;
  spriteId: number;
  /** Dado extra do produto (cor, padrão do piso…); vai no 3492. */
  extra: string;
  /** Quantas unidades a oferta entrega. */
  count: number;
  badge?: string;
}

export interface CatalogOffer {
  offerId: number;
  name: string;
  rent: boolean;
  credits: number;
  points: number;
  pointsType: number;
  giftable: boolean;
  products: CatalogProduct[];
  clubLevel: number;
  bundle: boolean;
}

export interface CatalogPage {
  pageId: number;
  catalogType: string;
  layout: string;
  offers: CatalogOffer[];
}

/** IN 804 — página do catálogo. Só o que interessa: ofertas, preços e produtos. */
export function parseCatalogPage(r: PacketReader): CatalogPage {
  const pageId = r.int32();
  const catalogType = r.string();
  const layout = r.string();
  const nImg = r.int32();
  for (let i = 0; i < nImg; i++) r.string();
  const nTxt = r.int32();
  for (let i = 0; i < nTxt; i++) r.string();
  const nOffers = r.int32();
  const offers: CatalogOffer[] = [];
  for (let i = 0; i < nOffers; i++) {
    const o: CatalogOffer = { offerId: r.int32(), name: r.string(), rent: r.boolean(), credits: r.int32(), points: r.int32(), pointsType: r.int32(), giftable: r.boolean(), products: [], clubLevel: 0, bundle: false };
    const nProd = r.int32();
    for (let j = 0; j < nProd; j++) {
      const type = r.string();
      if (type === 'b') {
        o.products.push({ type, spriteId: -1, extra: '', count: 1, badge: r.string() });
      } else {
        const spriteId = r.int32();
        const extra = r.string();
        const count = r.int32();
        const unique = r.boolean();
        if (unique) {
          r.int32();
          r.int32();
        }
        o.products.push({ type, spriteId, extra, count });
      }
    }
    o.clubLevel = r.int32();
    o.bundle = r.boolean();
    r.boolean(); // isPet
    r.string(); // preview
    offers.push(o);
  }
  return { pageId, catalogType, layout, offers };
}

/** IN 869 — compra aceita. Só o começo (id da oferta e nome) interessa. */
export function parsePurchaseOk(r: PacketReader): { offerId: number; name: string } {
  return { offerId: r.int32(), name: r.string() };
}

/** IN 2103 — itens novos no inventário, por categoria (1 = mobis). */
export function parseUnseenItems(r: PacketReader): { category: number; ids: number[] }[] {
  const n = r.int32();
  const out: { category: number; ids: number[] }[] = [];
  for (let i = 0; i < n; i++) {
    const category = r.int32();
    const count = r.int32();
    const ids: number[] = [];
    for (let j = 0; j < count; j++) ids.push(r.int32());
    out.push({ category, ids });
  }
  return out;
}

export interface InventoryItem {
  itemId: number;
  /** `S` mobi de chão, `I` mobi de parede (inclui piso, papel de parede e paisagem). */
  type: 'S' | 'I';
  spriteId: number;
  category: number;
  /** Estado / dado extra (para piso e papel de parede é o padrão, ex.: "111"). */
  state: string;
  tradeable: boolean;
  /** -1 = não está em quarto nenhum. */
  roomId: number;
}

export interface InventoryFragment {
  totalFragments: number;
  fragment: number;
  declaredCount: number;
  items: InventoryItem[];
  partial: boolean;
}

/** IN 994 — um fragmento do inventário de mobis. Tolerante a corpo truncado. */
export function parseInventory(r: PacketReader): InventoryFragment {
  const totalFragments = r.int32();
  const fragment = r.int32();
  const declaredCount = r.int32();
  const items: InventoryItem[] = [];
  let partial = false;
  for (let i = 0; i < declaredCount; i++) {
    try {
      const itemId = r.int32();
      const type = r.string() === 'I' ? 'I' : 'S';
      r.int32(); // ref
      const spriteId = r.int32();
      const category = r.int32();
      const state = skipObjectData(r, r.int32());
      r.boolean(); // recyclable
      const tradeable = r.boolean();
      r.boolean(); // groupable
      r.boolean(); // sellable
      r.int32(); // expires
      r.boolean(); // rent started
      const roomId = r.int32();
      if (type === 'S') {
        r.string(); // slot
        r.int32(); // extra
      }
      items.push({ itemId, type, spriteId, category, state, tradeable, roomId });
    } catch {
      partial = true;
      break;
    }
  }
  return { totalFragments, fragment, declaredCount, items, partial };
}

/* ------------------------------------ quartos ------------------------------------ */

export interface RoomData {
  roomId: number;
  name: string;
  ownerId: number;
  ownerName: string;
  doorMode: number;
  userCount: number;
  maxUserCount: number;
  description: string;
  tradeMode: number;
  score: number;
  ranking: number;
  categoryId: number;
  tags: string[];
  officialRoomPicRef?: string;
  groupId?: number;
  groupName?: string;
  groupBadge?: string;
}

/** RoomDataParser do Nitro (usado por 687 e 2690). */
export function parseRoomData(r: PacketReader): RoomData {
  const d: RoomData = {
    roomId: r.int32(),
    name: r.string(),
    ownerId: r.int32(),
    ownerName: r.string(),
    doorMode: r.int32(),
    userCount: r.int32(),
    maxUserCount: r.int32(),
    description: r.string(),
    tradeMode: r.int32(),
    score: r.int32(),
    ranking: r.int32(),
    categoryId: r.int32(),
    tags: [],
  };
  const tagCount = r.int32();
  for (let i = 0; i < tagCount; i++) d.tags.push(r.string());
  const bitmask = r.int32();
  if (bitmask & 1) d.officialRoomPicRef = r.string();
  if (bitmask & 2) {
    d.groupId = r.int32();
    d.groupName = r.string();
    d.groupBadge = r.string();
  }
  if (bitmask & 4) {
    r.string(); // roomAdName
    r.string(); // roomAdDescription
    r.int32(); // roomAdExpiresInMin
  }
  return d;
}

/** IN 687 */
export function parseGuestRoomResult(r: PacketReader): { enterRoom: boolean; room: RoomData } {
  const enterRoom = r.boolean();
  const room = parseRoomData(r);
  return { enterRoom, room };
}

export interface NavigatorBlock {
  searchCode: string;
  text: string;
  rooms: RoomData[];
}

/** IN 2690 */
export function parseNavigatorResults(r: PacketReader): { searchCode: string; filter: string; blocks: NavigatorBlock[] } {
  const searchCode = r.string();
  const filter = r.string();
  const blockCount = r.int32();
  const blocks: NavigatorBlock[] = [];
  for (let b = 0; b < blockCount; b++) {
    const code = r.string();
    const text = r.string();
    r.int32(); // actionAllowed
    r.boolean(); // forceClosed
    r.int32(); // viewMode
    const roomCount = r.int32();
    const rooms: RoomData[] = [];
    for (let i = 0; i < roomCount; i++) rooms.push(parseRoomData(r));
    blocks.push({ searchCode: code, text, rooms });
  }
  return { searchCode, filter, blocks };
}

/* ------------------------------------ sistema ------------------------------------ */

/** IN 286 — estrutura não fechada; devolve as strings encontradas (título, texto, botão…). */
export function parseServerDialog(body: Uint8Array): { strings: string[] } {
  return { strings: extractStrings(body).map((s) => s.value) };
}

/** IN 432 — pares comando/descrição (custom Habblet). */
export function parseHabbletCommands(body: Uint8Array): { command: string; description: string }[] {
  const strs = extractStrings(body).map((s) => s.value);
  const out: { command: string; description: string }[] = [];
  for (let i = 0; i + 1 < strs.length; i += 2) out.push({ command: strs[i], description: strs[i + 1] });
  return out;
}
