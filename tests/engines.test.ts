import { beforeEach, describe, expect, it } from 'vitest';
import { GameState } from '../src/protocol/state/GameState';
import { createGameActions } from '../src/protocol/actions';
import type { GameActions } from '../src/protocol/actions';
import { IN as H, OUT as O } from '../src/protocol/nitro/headers';
import {
  AddUserAllEngine, AutoAcceptEngine, AutoMessageEngine, ConsoleReplyEngine, EventCursor, NudgeEngine, WhisperReplyEngine,
} from '../src/addons/protocol/engines';
import type { Engine, EngineTick } from '../src/addons/protocol/engines';
import {
  defaultAddUserAllConfig, defaultAutoAcceptConfig, defaultAutoReplyWhispersConfig, defaultCommandsLoopConfig, defaultConsoleTrackerConfig, defaultNudgeEveryoneConfig,
} from '../shared/addon-config';
import {
  IN, OUT, captureSends, chat, consoleMessage, friendRequest, friendsList, navigatorResults, roomData, roomEnterError, roomUsers, selfInfo, serverDialog, unitRemove, w,
} from './helpers';
import type { RoomUserSpec } from './helpers';

const ME = { id: 5909416, name: 'DATAPOL' };

/** Um mundo de teste: GameState real, ações reais gravando o que enviam, e um relógio manual. */
class World {
  state = new GameState();
  sends = captureSends();
  actions: GameActions = createGameActions(this.sends.send, this.state);
  logs: string[] = [];
  now = 100_000;
  agentReady = true;

  tick<C>(engine: Engine<C>, config: C, enabled = true): void {
    const t: EngineTick<C> = {
      now: this.now,
      enabled,
      agentReady: this.agentReady,
      config,
      snapshot: this.state.snapshot(),
      state: this.state,
      actions: this.actions,
      log: (m) => this.logs.push(m),
    };
    engine.tick(t);
  }

  advance(ms: number): void {
    this.now += ms;
  }

  login(): void {
    this.state.handle(IN(H.USER_INFO, selfInfo(ME.id, ME.name), this.now));
    this.state.handle(IN(H.FRIENDS_LIST, friendsList([{ id: 300, name: 'Lolinha' }]), this.now));
  }

  enterRoom(roomId = 7078217, users: RoomUserSpec[] = [{ id: 200, name: 'Wzzer', roomIndex: 2 }, { id: 300, name: 'Lolinha', roomIndex: 3 }]): void {
    this.state.handle(OUT(O.ROOM_ENTER, w().int32(roomId).string(''), this.now));
    this.state.handle(IN(H.ROOM_READY, undefined, this.now));
    this.state.handle(IN(H.ROOM_USERS, roomUsers([{ id: ME.id, name: ME.name, roomIndex: 1 }, ...users]), this.now));
    this.state.handle(IN(H.ROOM_DATA, roomData({ roomId, name: 'Sala' }), this.now));
  }

  /** O servidor nos tira da sala (expulsão). */
  kick(): void {
    this.state.handle(IN(H.GENERIC_ERROR, w().int32(4008), this.now));
    this.state.handle(IN(H.UNIT_REMOVE, unitRemove(1), this.now));
    this.state.handle(IN(H.HOTEL_VIEW, undefined, this.now));
  }

  sentNames(header = O.REQUEST_FRIEND): string[] {
    return this.sends.byHeader(header).map((p) => p.reader().string());
  }
}

let world: World;
beforeEach(() => {
  world = new World();
});

describe('EventCursor', () => {
  it('lê só os eventos novos e sobrevive ao limite do log', () => {
    const c = new EventCursor();
    world.login();
    world.enterRoom();
    c.skipToEnd(world.state.snapshot());
    expect(c.take(world.state.snapshot())).toEqual([]);
    for (let i = 0; i < 650; i++) world.state.handle(IN(H.CHAT, chat(2, 'm' + i), world.now));
    const got = c.take(world.state.snapshot());
    expect(got).toHaveLength(600); // perdemos 50, ficamos com o que ainda existe
    expect(got.at(-1)).toMatchObject({ kind: 'chat', text: 'm649' });
    world.state.handle(IN(H.CHAT, chat(2, 'último'), world.now));
    expect(c.take(world.state.snapshot())).toMatchObject([{ kind: 'chat', text: 'último' }]);
  });
});

describe('AddUserAllEngine', () => {
  const cfg = { ...defaultAddUserAllConfig, ignoreNames: [], protocolIntervalMs: 2500, autoRoom: false };

  it('envia um 3157 por vez, pulando amigos, e respeita o intervalo', () => {
    const e = new AddUserAllEngine();
    world.login();
    world.enterRoom();
    world.tick(e, cfg);
    expect(world.sentNames()).toEqual(['Wzzer']); // Lolinha é amiga
    world.advance(500);
    world.state.handle(IN(H.ROOM_USERS, roomUsers([{ id: 400, name: 'Novo', roomIndex: 4 }]), world.now));
    world.tick(e, cfg);
    expect(world.sentNames()).toEqual(['Wzzer']); // ainda no intervalo
    world.advance(2500);
    world.tick(e, cfg);
    expect(world.sentNames()).toEqual(['Wzzer', 'Novo']);
    world.advance(3000);
    world.tick(e, cfg);
    expect(world.sentNames()).toEqual(['Wzzer', 'Novo']); // nada mais a pedir
    expect(e.stats.doneNames).toEqual(['wzzer', 'novo']);
  });

  it('não repete quem já foi pedido nesta sessão (mesmo pelo DOM) nem os ignorados', () => {
    const e = new AddUserAllEngine();
    world.login();
    world.enterRoom();
    world.state.handle(OUT(O.REQUEST_FRIEND, w().string('Wzzer'), world.now));
    world.state.handle(IN(H.ROOM_USERS, roomUsers([{ id: 600, name: 'Chato', roomIndex: 6 }]), world.now));
    world.tick(e, { ...cfg, ignoreNames: ['chato'] });
    expect(world.sends.byHeader(O.REQUEST_FRIEND)).toHaveLength(0);
    expect(e.stats.ignoredNames).toEqual(['Chato']);
  });

  it('a lista sobrevive à expulsão: continua pedindo de fora do quarto', () => {
    const e = new AddUserAllEngine();
    world.login();
    world.enterRoom(7078217, [{ id: 200, name: 'A', roomIndex: 2 }, { id: 201, name: 'B', roomIndex: 4 }, { id: 202, name: 'C', roomIndex: 5 }]);
    world.tick(e, cfg);
    expect(world.sentNames()).toEqual(['A']);
    world.advance(1000);
    world.kick();
    world.tick(e, cfg);
    expect(e.stats.queue).toBe(2);
    world.advance(2500);
    world.tick(e, cfg);
    world.advance(2500);
    world.tick(e, cfg);
    expect(world.sentNames()).toEqual(['A', 'B', 'C']);
    expect(world.logs.some((l) => /Fora de quarto. Continuando/.test(l))).toBe(true);
  });

  it('diálogo do servidor logo após o pedido marca "não aceita solicitações"', () => {
    const e = new AddUserAllEngine();
    world.login();
    world.enterRoom();
    world.tick(e, cfg);
    world.advance(800);
    world.state.handle(IN(H.SERVER_DIALOG, serverDialog('Aviso', 'Este usuário não aceita pedidos de amizade', 'OK'), world.now));
    world.tick(e, cfg);
    expect(e.stats.notAcceptingRequestsNames).toEqual(['Wzzer']);
  });

  it('registra o aceite quando o alvo aparece num 2800', () => {
    const e = new AddUserAllEngine();
    world.login();
    world.enterRoom();
    world.tick(e, cfg);
    world.state.handle(IN(H.FRIENDS_UPDATE, w().int32(0).int32(1).int32(0).int32(200).string('Wzzer').int32(0).boolean(true).boolean(true).string('f').int32(0).string('').string('').string('').boolean(false).boolean(false).boolean(false).int16(0), world.now));
    world.tick(e, cfg);
    expect(world.logs.some((l) => /Wzzer aceitou/.test(l))).toBe(true);
  });

  describe('Auto Room', () => {
    const ar = { ...cfg, autoRoom: true, autoRoomIdleMs: 5000, autoRoomMinUsers: 3, autoRoomSearchCode: 'hotel_view' };

    it('lista esgotada por X s → busca (249) → visita o mais cheio aberto (2230) → 2312 cru se o cliente não reagir', () => {
      const e = new AddUserAllEngine();
      world.login();
      world.enterRoom(1, [{ id: 300, name: 'Lolinha', roomIndex: 3 }]); // só a amiga: nada a pedir
      world.tick(e, ar);
      expect(world.sends.byHeader(O.NAVIGATOR_SEARCH)).toHaveLength(0);
      world.advance(5100);
      world.tick(e, ar);
      expect(world.sends.byHeader(O.NAVIGATOR_SEARCH).map((p) => p.reader().string())).toEqual(['hotel_view']);
      world.state.handle(IN(H.NAVIGATOR_RESULTS, navigatorResults([
        { roomId: 10, name: 'Cheia mas trancada', userCount: 40, doorMode: 1 },
        { roomId: 11, name: 'Lotada', userCount: 50, maxUserCount: 50 },
        { roomId: 12, name: 'Boa', userCount: 20 },
        { roomId: 13, name: 'Vazia', userCount: 1 },
      ]), world.now));
      world.tick(e, ar);
      const visit = world.sends.byHeader(O.GET_GUEST_ROOM);
      expect(visit).toHaveLength(1);
      const r = visit[0].reader();
      expect([r.int32(), r.int32(), r.int32()]).toEqual([12, 0, 1]);
      // o cliente não mandou o 2312 em 2,5 s: plano B
      world.advance(2600);
      world.tick(e, ar);
      const enter = world.sends.byHeader(O.ROOM_ENTER);
      expect(enter).toHaveLength(1);
      expect(enter[0].reader().int32()).toBe(12);
    });

    it('entrada recusada (899) bloqueia o quarto e escolhe outro', () => {
      const e = new AddUserAllEngine();
      world.login();
      world.enterRoom(1, [{ id: 300, name: 'Lolinha', roomIndex: 3 }]);
      world.tick(e, ar); // liga: começa a contar o tempo ocioso
      world.advance(5100);
      world.tick(e, ar);
      world.state.handle(IN(H.NAVIGATOR_RESULTS, navigatorResults([{ roomId: 12, name: 'Boa', userCount: 20 }, { roomId: 14, name: 'Outra', userCount: 10 }]), world.now));
      world.tick(e, ar);
      expect(world.sends.byHeader(O.GET_GUEST_ROOM)).toHaveLength(1);
      // o cliente manda o 2312, o servidor recusa
      world.state.handle(OUT(O.ROOM_ENTER, w().int32(12).string(''), world.now));
      world.state.handle(IN(H.UNIT_REMOVE, unitRemove(1), world.now));
      world.state.handle(IN(H.ROOM_ENTER_ERROR, roomEnterError(1), world.now));
      world.state.handle(IN(H.HOTEL_VIEW, undefined, world.now));
      world.tick(e, ar);
      expect(world.logs.some((l) => /entrada recusada no quarto #12 \(cheio\)/.test(l))).toBe(true);
      world.advance(2100); // fora de quarto: espera curta
      world.tick(e, ar);
      const visits = world.sends.byHeader(O.GET_GUEST_ROOM).map((p) => p.reader().int32());
      expect(visits).toEqual([12, 14]);
    });
  });
});

describe('AutoAcceptEngine', () => {
  it('aceita após o atraso, exceto nomes ignorados', () => {
    const e = new AutoAcceptEngine();
    const cfg = { ...defaultAutoAcceptConfig, delayMs: 1500, ignoreNames: ['Spam'] };
    world.login();
    world.state.handle(IN(H.FRIEND_REQUEST, friendRequest(5904602, 'kehlaree'), world.now));
    world.state.handle(IN(H.FRIEND_REQUEST, friendRequest(777, 'Spam'), world.now));
    world.tick(e, cfg);
    expect(world.sends.byHeader(O.ACCEPT_FRIENDS)).toHaveLength(0);
    world.advance(1600);
    world.tick(e, cfg);
    const acc = world.sends.byHeader(O.ACCEPT_FRIENDS);
    expect(acc).toHaveLength(1);
    const r = acc[0].reader();
    expect([r.int32(), r.int32()]).toEqual([1, 5904602]);
    expect(world.state.snapshot().pendingRequests.map((p) => p.name)).toEqual(['Spam']);
  });
});

describe('WhisperReplyEngine', () => {
  it('responde sussurros de outros com 1543, ignora os meus e limita a frequência', () => {
    const e = new WhisperReplyEngine();
    const cfg = { ...defaultAutoReplyWhispersConfig, message: 'ausente', alternationPrefix: '- ' };
    world.login();
    world.enterRoom();
    world.state.handle(IN(H.WHISPER, chat(2, 'antes de ligar'), world.now));
    world.tick(e, cfg); // liga: ignora o histórico
    world.state.handle(IN(H.WHISPER, chat(1, 'eco do meu sussurro'), world.now));
    world.state.handle(IN(H.WHISPER, chat(2, 'oi?'), world.now));
    world.state.handle(IN(H.WHISPER, chat(2, 'tá aí?'), world.now));
    world.tick(e, cfg);
    const sent = world.sends.byHeader(O.WHISPER).map((p) => p.reader().string());
    expect(sent).toEqual(['Wzzer ausente']); // um só: a segunda veio dentro de 1,5 s
    world.advance(2000);
    world.state.handle(IN(H.WHISPER, chat(3, 'psiu'), world.now));
    world.tick(e, cfg);
    expect(world.sends.byHeader(O.WHISPER).map((p) => p.reader().string())).toEqual(['Wzzer ausente', 'Lolinha - ausente']);
  });
});

describe('ConsoleReplyEngine', () => {
  it('responde pelo 3567 só a mensagens novas e respeita o intervalo por remetente', () => {
    const e = new ConsoleReplyEngine();
    const cfg = { ...defaultConsoleTrackerConfig, message: 'volto já', minSecondsBetweenRepliesPerUser: 20, respondOnlyToNewMessages: true };
    world.login();
    world.tick(e, cfg);
    world.state.handle(IN(H.CONSOLE_MESSAGE, consoleMessage(300, 'velha', 400), world.now));
    world.state.handle(IN(H.CONSOLE_MESSAGE, consoleMessage(300, 'nova', 2), world.now));
    world.state.handle(IN(H.CONSOLE_MESSAGE, consoleMessage(300, 'outra nova', 1), world.now));
    world.tick(e, cfg);
    const sent = world.sends.byHeader(O.CONSOLE_SEND).map((p) => { const r = p.reader(); return [r.int32(), r.string()]; });
    expect(sent).toEqual([[300, 'volto já']]);
    world.advance(21_000);
    world.state.handle(IN(H.CONSOLE_MESSAGE, consoleMessage(300, 'de novo', 1), world.now));
    world.tick(e, cfg);
    expect(world.sends.byHeader(O.CONSOLE_SEND)).toHaveLength(2);
  });
});

describe('AutoMessageEngine', () => {
  it('percorre a lista com o espaçamento configurado e reinicia após o intervalo do ciclo', () => {
    const e = new AutoMessageEngine();
    const cfg = { ...defaultCommandsLoopConfig, extraCommands: [':sit', ':dance'], extraCommandsIntervalMs: 60_000, extraBetweenCommandsMs: 2000 };
    const texts = () => world.sends.byHeader(O.CHAT).map((p) => p.reader().string());
    world.login();
    world.tick(e, cfg);
    expect(texts()).toEqual([':sit']);
    world.advance(1000);
    world.tick(e, cfg);
    expect(texts()).toEqual([':sit']);
    world.advance(1100);
    world.tick(e, cfg);
    expect(texts()).toEqual([':sit', ':dance']);
    world.advance(30_000);
    world.tick(e, cfg);
    expect(texts()).toEqual([':sit', ':dance']);
    world.advance(31_000);
    world.tick(e, cfg);
    expect(texts()).toEqual([':sit', ':dance', ':sit']);
  });
});

describe('NudgeEngine', () => {
  it('"clica" em cada usuário da sala (3301 + 431 + 2091 + 2138), um por vez, e recomeça após o ciclo', () => {
    const e = new NudgeEngine();
    const cfg = { ...defaultNudgeEveryoneConfig, engine: 'protocol' as const, ignoreNames: ['Lolinha'], intervalBetweenClicksMs: 1000, intervalBetweenLoopsMs: 5000 };
    world.login();
    world.enterRoom(1, [{ id: 200, name: 'Wzzer', roomIndex: 2, x: 4, y: 5 }, { id: 300, name: 'Lolinha', roomIndex: 3 }, { id: 400, name: 'Zé', roomIndex: 4 }]);
    world.tick(e, cfg);
    expect(world.sends.byHeader(O.GET_RELATIONSHIPS).map((p) => p.reader().int32())).toEqual([200]);
    const look = world.sends.byHeader(O.LOOK_TO)[0].reader();
    expect([look.int32(), look.int32()]).toEqual([4, 5]);
    expect(world.sends.byHeader(O.GET_USER_TAGS)[0].reader().int32()).toBe(2);
    world.tick(e, cfg);
    expect(world.sends.byHeader(O.GET_RELATIONSHIPS)).toHaveLength(1); // intervalo entre cliques
    world.advance(1000);
    world.tick(e, cfg);
    expect(world.sends.byHeader(O.GET_RELATIONSHIPS).map((p) => p.reader().int32())).toEqual([200, 400]);
    expect(e.stats).toMatchObject({ cycleCount: 1, clickedLastCycle: 2 });
    world.advance(1000);
    world.tick(e, cfg);
    expect(world.sends.byHeader(O.GET_RELATIONSHIPS)).toHaveLength(2); // aguardando o próximo ciclo
    world.advance(5000);
    world.tick(e, cfg);
    expect(world.sends.byHeader(O.GET_RELATIONSHIPS)).toHaveLength(3);
  });
});
