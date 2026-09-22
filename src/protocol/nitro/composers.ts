/**
 * Compositores: montam o corpo dos pacotes de saída. O envio em si (header + corpo)
 * é feito pelo agente no webview via `sendPacket(header, body)`.
 */
import { PacketWriter } from '../decode';
import { OUT } from './headers';

export interface OutgoingPacket {
  header: number;
  body: Uint8Array;
}

/** OUT 3157 — pedir amizade pelo nome. */
export function requestFriend(name: string): OutgoingPacket {
  return { header: OUT.REQUEST_FRIEND, body: new PacketWriter().string(name).bytes() };
}

/** OUT 137 — aceitar um ou mais pedidos pelo id de quem pediu. */
export function acceptFriends(userIds: number[]): OutgoingPacket {
  const w = new PacketWriter().int32(userIds.length);
  for (const id of userIds) w.int32(id);
  return { header: OUT.ACCEPT_FRIENDS, body: w.bytes() };
}

/** OUT 2312 — entrar em quarto. */
export function enterRoom(roomId: number, password = ''): OutgoingPacket {
  return { header: OUT.ROOM_ENTER, body: new PacketWriter().int32(roomId).string(password).bytes() };
}

/** OUT 2230 — dados do quarto. (roomId, 1, 0) é o que o cliente manda ao entrar; (roomId, 0, 1) faz o cliente entrar sozinho (687 → 2312). */
export function getGuestRoom(roomId: number, enterRoom = 1, forward = 0): OutgoingPacket {
  return { header: OUT.GET_GUEST_ROOM, body: new PacketWriter().int32(roomId).int32(enterRoom).int32(forward).bytes() };
}

/** OUT 249 — busca do navegador. */
export function navigatorSearch(code: string, filter = ''): OutgoingPacket {
  return { header: OUT.NAVIGATOR_SEARCH, body: new PacketWriter().string(code).string(filter).bytes() };
}

/** OUT 3320 — andar até (x, y). */
export function walkTo(x: number, y: number): OutgoingPacket {
  return { header: OUT.WALK_TO, body: new PacketWriter().int32(x).int32(y).bytes() };
}

/** OUT 3997 — seguir um amigo até o quarto dele (o cliente Nitro completa a entrada ao receber o 160). */
export function followFriend(userId: number): OutgoingPacket {
  return { header: OUT.FOLLOW_FRIEND, body: new PacketWriter().int32(userId).bytes() };
}

/** Respeitar um usuário (id da conta, não o índice na sala). */
export function respectUser(userId: number): OutgoingPacket {
  return { header: OUT.RESPECT_USER, body: new PacketWriter().int32(userId).bytes() };
}

/** Pedir para entrar num grupo pelo id. */
export function joinGroup(groupId: number): OutgoingPacket {
  return { header: OUT.GROUP_REQUEST, body: new PacketWriter().int32(groupId).bytes() };
}

/** Dar nota ao quarto atual (o cliente oficial manda 1). */
export function rateRoom(rating = 1): OutgoingPacket {
  return { header: OUT.ROOM_LIKE, body: new PacketWriter().int32(rating).bytes() };
}

/** Trocar o próprio visual: gênero ('M'/'F') e a string do visual (ex.: "hd-180-1.hr-828-61…"). */
export function setFigure(gender: string, figure: string): OutgoingPacket {
  return { header: OUT.USER_FIGURE, body: new PacketWriter().string(gender).string(figure).bytes() };
}

/** Convidar amigos (ids) para o quarto atual, com uma mensagem — o "selecionar todos e convidar" do console. */
export function roomInvite(userIds: number[], message: string): OutgoingPacket {
  const w = new PacketWriter().int32(userIds.length);
  for (const id of userIds) w.int32(id);
  return { header: OUT.SEND_ROOM_INVITE, body: w.string(message).bytes() };
}

/** Pedir o perfil de alguém pelo nick (responde 3898, com o visual, mesmo offline). */
export function profileByName(name: string): OutgoingPacket {
  return { header: OUT.USER_PROFILE_BY_NAME, body: new PacketWriter().string(name).bytes() };
}

/** OUT 3559 — pedir a casa da porta (resposta 1664). */
export function getRoomEntryTile(): OutgoingPacket {
  return { header: OUT.GET_ROOM_ENTRY_TILE, body: new Uint8Array(0) };
}

/** OUT 1687 — pedir as casas ocupadas por mobi (resposta 3990). */
export function getOccupiedTiles(): OutgoingPacket {
  return { header: OUT.GET_OCCUPIED_TILES, body: new Uint8Array(0) };
}

/* ------------------------------------ construção ------------------------------------ */

/** OUT 875 — salvar a planta do quarto pelo editor. `rows` sem o separador; o servidor espera `\r` entre as linhas. */
export function saveFloorPlan(rows: string[], door: { x: number; y: number; direction: number }, wallThickness = 0, floorThickness = 0, wallHeight = -1): OutgoingPacket {
  return { header: OUT.SAVE_FLOOR_PLAN, body: new PacketWriter().string(rows.join('\r')).int32(door.x).int32(door.y).int32(door.direction).int32(wallThickness).int32(floorThickness).int32(wallHeight).bytes() };
}

/** OUT 1258 — colocar mobi de chão do inventário em (x, y) com direção. */
export function placeFloorItem(itemId: number, x: number, y: number, direction: number): OutgoingPacket {
  return { header: OUT.PLACE_OBJECT, body: new PacketWriter().string(`${itemId} ${x} ${y} ${direction}`).bytes() };
}

/** OUT 1258 — colocar mobi de parede do inventário na posição `:w=x,y l=x,y l` (o cliente manda um espaço no fim). */
export function placeWallItem(itemId: number, wallPosition: string): OutgoingPacket {
  return { header: OUT.PLACE_OBJECT, body: new PacketWriter().string(`${itemId} ${wallPosition.trim()} `).bytes() };
}

/** OUT 248 — mover/girar mobi de chão. */
export function moveFloorItem(itemId: number, x: number, y: number, direction: number): OutgoingPacket {
  return { header: OUT.MOVE_OBJECT, body: new PacketWriter().int32(itemId).int32(x).int32(y).int32(direction).bytes() };
}

/** OUT 99 — usar mobi de chão (avança o estado). */
export function useFloorItem(itemId: number): OutgoingPacket {
  return { header: OUT.USE_OBJECT, body: new PacketWriter().int32(itemId).int32(0).bytes() };
}

/** OUT 3456 — pegar mobi de chão de volta para o inventário. */
export function pickupFloorItem(itemId: number): OutgoingPacket {
  return { header: OUT.PICKUP_OBJECT, body: new PacketWriter().int32(10).int32(itemId).bytes() };
}

/** OUT 168 — mover mobi de parede. */
export function moveWallItem(itemId: number, wallPosition: string): OutgoingPacket {
  return { header: OUT.MOVE_WALL_ITEM, body: new PacketWriter().int32(itemId).string(wallPosition.trim()).bytes() };
}

/** OUT 210 — usar mobi de parede. */
export function useWallItem(itemId: number): OutgoingPacket {
  return { header: OUT.USE_WALL_ITEM, body: new PacketWriter().int32(itemId).int32(0).bytes() };
}

/** OUT 711 — aplicar piso / papel de parede / paisagem do inventário. */
export function applyDecoration(itemId: number): OutgoingPacket {
  return { header: OUT.APPLY_DECORATION, body: new PacketWriter().int32(itemId).bytes() };
}

/** OUT 3150 — pedir o inventário de mobis. */
export function getInventory(): OutgoingPacket {
  return { header: OUT.GET_INVENTORY, body: new Uint8Array(0) };
}

/** OUT 1195 — pedir o índice do catálogo. */
export function getCatalogIndex(mode = 'NORMAL'): OutgoingPacket {
  return { header: OUT.GET_CATALOG_INDEX, body: new PacketWriter().string(mode).bytes() };
}

/** OUT 412 — pedir uma página do catálogo. */
export function getCatalogPage(pageId: number, mode = 'NORMAL'): OutgoingPacket {
  return { header: OUT.GET_CATALOG_PAGE, body: new PacketWriter().int32(pageId).int32(-1).string(mode).bytes() };
}

/** OUT 3492 — comprar uma oferta do catálogo. */
export function purchase(pageId: number, offerId: number, extraData = '', quantity = 1): OutgoingPacket {
  return { header: OUT.PURCHASE, body: new PacketWriter().int32(pageId).int32(offerId).string(extraData).int32(quantity).bytes() };
}

/** OUT 3301 — olhar para (x, y). */
export function lookTo(x: number, y: number): OutgoingPacket {
  return { header: OUT.LOOK_TO, body: new PacketWriter().int32(x).int32(y).bytes() };
}

/** OUT 431 — tags do usuário pelo índice na sala (parte do "clique" no avatar). */
export function getUserTags(roomIndex: number): OutgoingPacket {
  return { header: OUT.GET_USER_TAGS, body: new PacketWriter().int32(roomIndex).bytes() };
}

/** OUT 2091 — emblemas selecionados do usuário (parte do "clique" no avatar). */
export function getSelectedBadges(userId: number): OutgoingPacket {
  return { header: OUT.GET_SELECTED_BADGES, body: new PacketWriter().int32(userId).bytes() };
}

/** OUT 2138 — status de relacionamento com o usuário (parte do "clique" no avatar). */
export function getRelationships(userId: number): OutgoingPacket {
  return { header: OUT.GET_RELATIONSHIPS, body: new PacketWriter().int32(userId).bytes() };
}

/** OUT 1314 — falar na sala. Confirmado: `string texto`, `int32 estilo` (sem trackingId neste hotel). */
export function chat(text: string, styleId = 0): OutgoingPacket {
  return { header: OUT.CHAT, body: new PacketWriter().string(text).int32(styleId).bytes() };
}

/** OUT 2085 — gritar. NÃO CONFIRMADO em captura (padrão Nitro: `string texto`, `int32 estilo`). */
export function shout(text: string, styleId = 0): OutgoingPacket {
  return { header: OUT.SHOUT, body: new PacketWriter().string(text).int32(styleId).bytes() };
}

/** OUT 1543 — sussurrar. Confirmado: o texto é `"<nome> <mensagem>"`, depois `int32 estilo`. */
export function whisper(name: string, text: string, styleId = 0): OutgoingPacket {
  return { header: OUT.WHISPER, body: new PacketWriter().string(`${name} ${text}`).int32(styleId).bytes() };
}

/** OUT 1597 / 1474 — indicador de digitação (o cliente manda 1474 junto com a mensagem). */
export function typingStart(): OutgoingPacket {
  return { header: OUT.TYPING_START, body: new Uint8Array(0) };
}
export function typingStop(): OutgoingPacket {
  return { header: OUT.TYPING_STOP, body: new Uint8Array(0) };
}

/** OUT 3567 — mensagem no console para um amigo. Confirmado: `int32 userId`, `string texto`. */
export function consoleMessage(userId: number, text: string): OutgoingPacket {
  return { header: OUT.CONSOLE_SEND, body: new PacketWriter().int32(userId).string(text).bytes() };
}

/** OUT 2890 — NÃO CONFIRMADO em captura. Recusar pedidos (ou todos). */
export function declineFriends(userIds: number[], declineAll = false): OutgoingPacket {
  const w = new PacketWriter().boolean(declineAll).int32(userIds.length);
  for (const id of userIds) w.int32(id);
  return { header: OUT.DECLINE_FRIENDS, body: w.bytes() };
}
