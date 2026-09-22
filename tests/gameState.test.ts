import { beforeEach, describe, expect, it } from 'vitest';
import { GameState } from '../src/protocol/state/GameState';
import { IN as H, OUT as O } from '../src/protocol/nitro/headers';
import {
  IN, OUT, chat, consoleMessage, friendRequest, friendsList, friendsUpdate, navigatorResults, roomData, roomEnterError, roomUsers, selfInfo, serverDialog, unitRemove, unitStatuses, w,
} from './helpers';

const ME = { id: 5909416, name: 'DATAPOL' };

let state: GameState;
beforeEach(() => {
  state = new GameState();
});

/** Login + entrada num quarto com eu (idx 1) e mais dois usuários. */
function enterRoom(roomId = 7078217, t = 1000) {
  state.handle(IN(H.USER_INFO, selfInfo(ME.id, ME.name), t));
  state.handle(OUT(O.ROOM_ENTER, w().int32(roomId).string(''), t));
  state.handle(IN(H.ROOM_READY, undefined, t + 10));
  state.handle(IN(H.ROOM_USERS, roomUsers([
    { id: ME.id, name: ME.name, roomIndex: 1, x: 3, y: 3 },
    { id: 200, name: 'Wzzer', roomIndex: 2 },
    { id: 300, name: 'Lolinha', roomIndex: 3 },
  ]), t + 20));
  state.handle(IN(H.ROOM_DATA, roomData({ roomId, name: 'Sala Teste' }), t + 30));
}

const kinds = () => state.snapshot().events.map((e) => e.kind);

describe('login e amigos', () => {
  it('2725 define quem sou eu', () => {
    state.handle(IN(H.USER_INFO, selfInfo(ME.id, ME.name, 'missão')));
    expect(state.snapshot().me).toMatchObject({ id: ME.id, name: ME.name, motto: 'missão' });
    expect(kinds()).toEqual(['me']);
  });

  it('3130 em fragmentos: friendsLoaded só no último', () => {
    state.handle(IN(H.FRIENDS_LIST, friendsList([{ id: 1, name: 'a' }], 0, 2)));
    expect(state.snapshot().friendsLoaded).toBe(false);
    state.handle(IN(H.FRIENDS_LIST, friendsList([{ id: 2, name: 'b' }], 1, 2)));
    const s = state.snapshot();
    expect(s.friendsLoaded).toBe(true);
    expect(s.friends.map((f) => f.id).sort()).toEqual([1, 2]);
    expect(state.isFriend(2)).toBe(true);
  });

  it('3130 truncado: guarda os amigos que couberam, registra o aviso e ainda marca a lista como carregada', () => {
    const full = friendsList([{ id: 1, name: 'primeiro' }, { id: 2, name: 'segundo' }, { id: 3, name: 'terceiro' }]).bytes();
    const p = IN(H.FRIENDS_LIST, full.subarray(0, full.length - 8));
    p.truncated = true;
    state.handle(p);
    const s = state.snapshot();
    expect(s.friends.map((f) => f.id)).toEqual([1, 2]);
    expect(s.friendsLoaded).toBe(true);
    expect(s.decodeErrors).toBe(1);
    expect(s.events.at(-1)).toMatchObject({ kind: 'decode-error', header: H.FRIENDS_LIST });
  });

  it('2800 com id desconhecido depois da lista carregada = novo amigo (aceite de um pedido nosso)', () => {
    state.handle(IN(H.FRIENDS_LIST, friendsList([{ id: 1, name: 'antigo' }])));
    state.handle(IN(H.FRIENDS_UPDATE, friendsUpdate([{ id: 1, name: 'antigo', motto: 'mudou de sala' }])));
    expect(kinds().filter((k) => k === 'friend-added')).toHaveLength(0);
    state.handle(IN(H.FRIENDS_UPDATE, friendsUpdate([{ id: 2, name: 'novo' }])));
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'friend-added', friend: { id: 2, name: 'novo' } });
    state.handle(IN(H.FRIENDS_UPDATE, friendsUpdate([], [1])));
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'friend-removed', id: 1 });
    expect(state.isFriend(1)).toBe(false);
  });

  it('2800 antes da lista completa não gera friend-added (seria falso positivo no login)', () => {
    state.handle(IN(H.FRIENDS_UPDATE, friendsUpdate([{ id: 2, name: 'x' }])));
    expect(kinds()).not.toContain('friend-added');
  });

  it('2219 cria pedido pendente; o 137 (nosso ou do cliente) o remove', () => {
    state.handle(IN(H.FRIEND_REQUEST, friendRequest(5904602, 'kehlaree')));
    expect(state.snapshot().pendingRequests).toMatchObject([{ requestId: 5904602, name: 'kehlaree' }]);
    state.handle(OUT(O.ACCEPT_FRIENDS, w().int32(1).int32(5904602)));
    expect(state.snapshot().pendingRequests).toEqual([]);
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'friends-accepted-sent', ids: [5904602] });
  });

  it('3157 enviado (pelo app ou pelo DOM) marca o nome como já pedido', () => {
    state.handle(OUT(O.REQUEST_FRIEND, w().string('Wzzer')));
    expect(state.snapshot().requestedNames.has('wzzer')).toBe(true);
    // repetido não gera evento duplicado
    state.handle(OUT(O.REQUEST_FRIEND, w().string('wzzer')));
    expect(kinds().filter((k) => k === 'friend-request-sent')).toHaveLength(1);
  });
});

describe('quarto', () => {
  it('2312 → 758 → 374 → 687 monta a sala com id, nome e usuários', () => {
    enterRoom();
    const s = state.snapshot();
    expect(s.room).toMatchObject({ id: 7078217, name: 'Sala Teste' });
    expect(s.room.users.map((u) => u.name)).toEqual([ME.name, 'Wzzer', 'Lolinha']);
    expect(kinds()).toEqual(['me', 'room-enter', 'user-enter', 'user-enter', 'user-enter']);
    expect(state.inRoom).toBe(true);
  });

  it('1640 atualiza posição, direitos, movimento e postura', () => {
    enterRoom();
    state.handle(IN(H.UNIT_STATUS, unitStatuses([{ roomIndex: 2, x: 7, y: 8, actions: '/flatctrl 4/mv 8,8,0.0//' }]), 2000));
    const u = state.snapshot().room.users.find((x) => x.roomIndex === 2)!;
    expect(u).toMatchObject({ x: 7, y: 8, rights: 4, moveTarget: { x: 8, y: 8 }, lastMoveAt: 2000 });
    state.handle(IN(H.UNIT_STATUS, unitStatuses([{ roomIndex: 2, x: 8, y: 8, actions: '/flatctrl 4/sit 0.5//' }]), 2500));
    expect(state.snapshot().room.users.find((x) => x.roomIndex === 2)).toMatchObject({ moveTarget: null, posture: 'sit', lastMoveAt: 2000 });
  });

  it('2661 de outro usuário = user-leave; do meu avatar logo após o meu 2312 = troca de quarto', () => {
    enterRoom();
    state.handle(IN(H.UNIT_REMOVE, unitRemove(2), 3000));
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'user-leave', name: 'Wzzer' });
    state.handle(OUT(O.ROOM_ENTER, w().int32(999).string(''), 4000));
    state.handle(IN(H.UNIT_REMOVE, unitRemove(1), 4200));
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'room-leave', roomId: 7078217, name: 'Sala Teste', reason: 'switching' });
    expect(state.inRoom).toBe(false);
  });

  it('1600/4008 antes do meu 2661 = expulsão; 122 sozinho muito depois do 2312 também', () => {
    enterRoom();
    state.handle(IN(H.GENERIC_ERROR, w().int32(4008), 9000));
    state.handle(IN(H.UNIT_REMOVE, unitRemove(1), 9010));
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'room-leave', reason: 'kicked' });
    state.handle(IN(H.HOTEL_VIEW, undefined, 9020)); // já fora: não duplica
    expect(kinds().filter((k) => k === 'room-leave')).toHaveLength(1);

    enterRoom(555, 20000);
    state.handle(IN(H.HOTEL_VIEW, undefined, 40000));
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'room-leave', roomId: 555, reason: 'kicked' });
  });

  it('899 = entrada recusada: evento com o quarto pedido, sem 758 pendente', () => {
    enterRoom();
    state.handle(OUT(O.ROOM_ENTER, w().int32(4242).string(''), 5000));
    state.handle(IN(H.UNIT_REMOVE, unitRemove(1), 5100));
    state.handle(IN(H.ROOM_ENTER_ERROR, roomEnterError(1), 5110));
    state.handle(IN(H.HOTEL_VIEW, undefined, 5120));
    const evs = state.snapshot().events;
    expect(evs.at(-1)).toMatchObject({ kind: 'room-enter-error', roomId: 4242, reason: 1 });
    expect(state.snapshot().roomEnterSent.roomId).toBeNull();
    expect(state.inRoom).toBe(false);
  });

  it('160 (seguir) registra o quarto pendente e a saída seguinte é troca, não expulsão', () => {
    enterRoom();
    state.handle(IN(H.ROOM_FORWARD, w().int32(6539664), 30000));
    state.handle(IN(H.UNIT_REMOVE, unitRemove(1), 30500));
    state.handle(IN(H.ROOM_READY, undefined, 30600));
    const evs = state.snapshot().events;
    expect(evs.at(-3)).toMatchObject({ kind: 'room-forward', roomId: 6539664 });
    expect(evs.at(-2)).toMatchObject({ kind: 'room-leave', reason: 'switching' });
    expect(evs.at(-1)).toMatchObject({ kind: 'room-enter', roomId: 6539664 });
  });

  it('2690 preenche os quartos do navegador sem repetir ids', () => {
    state.handle(IN(H.NAVIGATOR_RESULTS, navigatorResults([{ roomId: 1, name: 'A', userCount: 3 }, { roomId: 1, name: 'A', userCount: 3 }, { roomId: 2, name: 'B' }])));
    expect(state.snapshot().navigatorRooms.map((r) => r.roomId)).toEqual([1, 2]);
  });
});

describe('chat, console e diálogos', () => {
  it('1446 resolve o nome pelo roomIndex e guarda a última fala do usuário', () => {
    enterRoom();
    state.handle(IN(H.CHAT, chat(2, 'oi galera'), 2000));
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'chat', name: 'Wzzer', text: 'oi galera', whisper: false, shout: false });
    expect(state.snapshot().room.users.find((u) => u.roomIndex === 2)?.lastChat).toMatchObject({ text: 'oi galera' });
    state.handle(IN(H.WHISPER, chat(3, 'psiu'), 2100));
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'chat', name: 'Lolinha', whisper: true });
  });

  it('1587 vira evento de console com o nome do amigo quando conhecido', () => {
    state.handle(IN(H.FRIENDS_LIST, friendsList([{ id: 44, name: 'Amigo' }])));
    state.handle(IN(H.CONSOLE_MESSAGE, consoleMessage(44, 'e aí', 3)));
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'console', senderId: 44, senderName: 'Amigo', text: 'e aí', secondsSinceSent: 3 });
  });

  it('286 vira evento dialog com as strings', () => {
    state.handle(IN(H.SERVER_DIALOG, serverDialog('Aviso', 'Este usuário não aceita pedidos de amizade', 'OK')));
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'dialog', strings: ['Aviso', 'Este usuário não aceita pedidos de amizade', 'OK'] });
  });
});

describe('candidatos e log de eventos', () => {
  it('friendRequestCandidates exclui eu, amigos, ignorados, já pedidos e não-usuários', () => {
    enterRoom();
    state.handle(IN(H.FRIENDS_LIST, friendsList([{ id: 300, name: 'Lolinha' }])));
    state.handle(IN(H.ROOM_USERS, roomUsers([{ id: 400, name: 'Pedido', roomIndex: 4 }, { id: 500, name: 'Bot', roomIndex: 5, type: 3 }, { id: 600, name: 'Ignorado', roomIndex: 6 }])));
    state.handle(OUT(O.REQUEST_FRIEND, w().string('Pedido')));
    expect(state.friendRequestCandidates(['ignorado']).map((u) => u.name)).toEqual(['Wzzer']);
  });

  it('o log guarda só os últimos 600 eventos, mas eventSeq conta todos', () => {
    enterRoom();
    for (let i = 0; i < 700; i++) state.handle(IN(H.CHAT, chat(2, 'msg ' + i), 2000 + i));
    const s = state.snapshot();
    expect(s.events).toHaveLength(600);
    expect(s.eventSeq).toBe(5 + 700);
    expect(s.events.at(-1)).toMatchObject({ kind: 'chat', text: 'msg 699' });
  });

  it('pacote com corpo inesperado conta como erro de decodificação sem derrubar o estado', () => {
    state.handle(IN(H.USER_INFO, w().int32(1))); // corpo curto demais
    expect(state.snapshot().decodeErrors).toBe(1);
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'decode-error', header: H.USER_INFO });
  });

  it('reset zera tudo, inclusive o eventSeq', () => {
    enterRoom();
    state.reset();
    const s = state.snapshot();
    expect(s.me).toBeNull();
    expect(s.room.id).toBeNull();
    expect(s.events).toEqual([]);
    expect(s.eventSeq).toBe(0);
  });
});
