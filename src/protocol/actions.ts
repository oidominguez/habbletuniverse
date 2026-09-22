/**
 * Ações por protocolo: montam o pacote com os compositores e enviam pelo agente.
 * Mantêm o GameState informado do que foi feito localmente.
 */
import * as composers from './nitro/composers';
import type { GameState } from './state/GameState';

export type SendPacket = (header: number, body: Uint8Array) => void;

/** Convites por pacote: o cliente manda todos de uma vez, mas listas de centenas de amigos ficam mais seguras em lotes. */
const INVITE_BATCH = 100;

export interface GameActions {
  requestFriend(name: string): void;
  acceptFriends(userIds: number[]): void;
  /** Manda o 2312 cru. Funciona, mas se o cliente estiver na visão do hotel a interface não acompanha (sem sessão de quarto). */
  enterRoom(roomId: number, password?: string): void;
  /**
   * Entra pelo caminho do próprio cliente: 2230 (roomId, 0, 1) → 687 → o Nitro cria a sessão e manda o 2312.
   * A interface acompanha mesmo a partir da visão do hotel. Só funciona em quarto aberto (com campainha/senha
   * o cliente mostra o diálogo e não entra).
   */
  visitRoom(roomId: number): void;
  navigatorSearch(code: string, filter?: string): void;
  lookTo(x: number, y: number): void;
  chat(text: string): void;
  /** Grito (2085). Header do Nitro padrão, ainda não confirmado em captura neste hotel. */
  shout(text: string): void;
  whisper(name: string, text: string): void;
  /** Mensagem no console (messenger) para um amigo, pelo id. */
  consoleMessage(userId: number, text: string): void;
  /** Anda até (x, y) na sala atual. */
  walkTo(x: number, y: number): void;
  /** Segue um amigo até o quarto dele (3997); o cliente completa a entrada sozinho. */
  followFriend(userId: number): void;
  /** Respeita um usuário (2694, confirmado em 17/09/2026). O servidor confirma a todos na sala com 2815. */
  respect(userId: number): void;
  /** Pede para entrar num grupo pelo id (998). */
  joinGroup(groupId: number): void;
  /** Dá nota ao quarto atual (3582). */
  rateRoom(): void;
  /** Troca o próprio visual (2730): gênero 'M'/'F' e a string do visual. O servidor confirma com 2429. */
  setFigure(gender: string, figure: string): void;
  /** Pede o perfil de alguém pelo nick (2249); a resposta 3898 traz o visual mesmo com a pessoa offline. */
  requestProfile(name: string): void;
  /** Convida amigos (ids) para o quarto atual (1276), em lotes para não estourar o pacote. Devolve quantos foram convidados. */
  inviteToRoom(userIds: number[], message: string): number;
  /**
   * Reproduz o clique num avatar: 3301 (olhar para a posição) + 431 (tags) + 2091 (emblemas) + 2138
   * (relacionamentos) — o quarteto que o cliente manda ao abrir o menu de um usuário. Base do Nudge por protocolo.
   */
  clickUser(user: { id: number; roomIndex: number; x: number; y: number }): void;
  /** Pede a casa da porta (3559 → 1664) e as casas ocupadas (1687 → 3990): o que o `:floor` do cliente faz. */
  requestRoomLayout(): void;

  /* ---- construção, catálogo e inventário (só em quarto próprio) ---- */
  /** Salva a planta pelo editor (875). O servidor manda reentrar no quarto. */
  saveFloorPlan(rows: string[], door: { x: number; y: number; direction: number }, wallHeight?: number): void;
  /** Coloca um mobi de chão do inventário (1258). */
  placeFloorItem(itemId: number, x: number, y: number, direction: number): void;
  /** Coloca um mobi de parede do inventário (1258, posição `:w=…`). */
  placeWallItem(itemId: number, wallPosition: string): void;
  /** Move/gira um mobi de chão (248). Com `:up N` / `:state N` ligados, aplica altura/estado. */
  moveFloorItem(itemId: number, x: number, y: number, direction: number): void;
  /** Avança o estado de um mobi de chão (99). */
  useFloorItem(itemId: number): void;
  /** Pega um mobi de chão de volta (3456). */
  pickupFloorItem(itemId: number): void;
  moveWallItem(itemId: number, wallPosition: string): void;
  useWallItem(itemId: number): void;
  /** Aplica piso / papel de parede / paisagem do inventário (711). */
  applyDecoration(itemId: number): void;
  requestInventory(): void;
  requestCatalogIndex(): void;
  requestCatalogPage(pageId: number): void;
  /** Compra uma oferta (3492). */
  purchase(pageId: number, offerId: number, extraData?: string, quantity?: number): void;
}

export interface GameActionsOptions {
  /**
   * true = não há cliente Nitro do outro lado (modo sem tela): `visitRoom` manda o 2312 direto, porque
   * ninguém iria reagir ao 687 com o 2312 "sozinho" e não há interface para acompanhar.
   */
  directEnter?: () => boolean;
}

export function createGameActions(send: SendPacket, state: GameState, opts: GameActionsOptions = {}): GameActions {
  const fire = (p: composers.OutgoingPacket) => send(p.header, p.body);
  return {
    requestFriend(name) {
      const n = name.trim();
      if (!n) return;
      fire(composers.requestFriend(n));
      state.noteFriendRequestSent(n);
    },
    acceptFriends(userIds) {
      if (userIds.length === 0) return;
      fire(composers.acceptFriends(userIds));
      state.noteAcceptSent(userIds);
    },
    enterRoom(roomId, password = '') {
      fire(composers.enterRoom(roomId, password));
    },
    visitRoom(roomId) {
      if (opts.directEnter?.()) fire(composers.enterRoom(roomId));
      else fire(composers.getGuestRoom(roomId, 0, 1));
    },
    navigatorSearch(code, filter = '') {
      fire(composers.navigatorSearch(code, filter));
    },
    lookTo(x, y) {
      fire(composers.lookTo(x, y));
    },
    chat(text) {
      if (!text.trim()) return;
      fire(composers.typingStop());
      fire(composers.chat(text));
    },
    shout(text) {
      if (!text.trim()) return;
      fire(composers.typingStop());
      fire(composers.shout(text));
    },
    whisper(name, text) {
      if (!name.trim() || !text.trim()) return;
      fire(composers.typingStop());
      fire(composers.whisper(name.trim(), text));
    },
    consoleMessage(userId, text) {
      if (text.trim()) fire(composers.consoleMessage(userId, text));
    },
    walkTo(x, y) {
      fire(composers.walkTo(x, y));
    },
    followFriend(userId) {
      fire(composers.followFriend(userId));
    },
    respect(userId) {
      fire(composers.respectUser(userId));
    },
    joinGroup(groupId) {
      fire(composers.joinGroup(groupId));
    },
    rateRoom() {
      fire(composers.rateRoom(1));
    },
    setFigure(gender, figure) {
      if (figure.trim()) fire(composers.setFigure(gender, figure.trim()));
    },
    requestProfile(name) {
      if (name.trim()) fire(composers.profileByName(name.trim()));
    },
    inviteToRoom(userIds, message) {
      const ids = [...new Set(userIds)];
      for (let i = 0; i < ids.length; i += INVITE_BATCH) fire(composers.roomInvite(ids.slice(i, i + INVITE_BATCH), message));
      return ids.length;
    },
    requestRoomLayout() {
      fire(composers.getRoomEntryTile());
      fire(composers.getOccupiedTiles());
    },
    saveFloorPlan(rows, door, wallHeight = -1) {
      fire(composers.saveFloorPlan(rows, door, 0, 0, wallHeight));
    },
    placeFloorItem(itemId, x, y, direction) {
      fire(composers.placeFloorItem(itemId, x, y, direction));
    },
    placeWallItem(itemId, wallPosition) {
      fire(composers.placeWallItem(itemId, wallPosition));
    },
    moveFloorItem(itemId, x, y, direction) {
      fire(composers.moveFloorItem(itemId, x, y, direction));
    },
    useFloorItem(itemId) {
      fire(composers.useFloorItem(itemId));
    },
    pickupFloorItem(itemId) {
      fire(composers.pickupFloorItem(itemId));
    },
    moveWallItem(itemId, wallPosition) {
      fire(composers.moveWallItem(itemId, wallPosition));
    },
    useWallItem(itemId) {
      fire(composers.useWallItem(itemId));
    },
    applyDecoration(itemId) {
      fire(composers.applyDecoration(itemId));
    },
    requestInventory() {
      fire(composers.getInventory());
    },
    requestCatalogIndex() {
      fire(composers.getCatalogIndex());
    },
    requestCatalogPage(pageId) {
      fire(composers.getCatalogPage(pageId));
    },
    purchase(pageId, offerId, extraData = '', quantity = 1) {
      fire(composers.purchase(pageId, offerId, extraData, Math.max(1, quantity)));
    },
    clickUser(user) {
      fire(composers.lookTo(user.x, user.y));
      fire(composers.getUserTags(user.roomIndex));
      fire(composers.getSelectedBadges(user.id));
      fire(composers.getRelationships(user.id));
    },
  };
}
