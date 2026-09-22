import { beforeEach, describe, expect, it } from 'vitest';
import { GameState } from '../src/protocol/state/GameState';
import { createGameActions } from '../src/protocol/actions';
import type { GameActions } from '../src/protocol/actions';
import { IN as H, OUT as O } from '../src/protocol/nitro/headers';
import { FollowEngine, approachTiles, rankApproachTiles, tileDistance } from '../src/addons/protocol/engines';
import type { EngineTick, FollowConfig } from '../src/addons/protocol/engines';
import { IN, OUT, captureSends, friendsList, roomData, roomUsers, selfInfo, unitRemove, unitStatuses, w } from './helpers';

const ME = { id: 1, name: 'Eu' };

class World {
  state = new GameState();
  sends = captureSends();
  actions: GameActions = createGameActions(this.sends.send, this.state);
  logs: string[] = [];
  now = 50_000;
  engine = new FollowEngine();

  constructor() {
    this.state.handle(IN(H.USER_INFO, selfInfo(ME.id, ME.name), this.now));
    this.state.handle(IN(H.FRIENDS_LIST, friendsList([{ id: 300, name: 'Amiga' }]), this.now));
    this.state.handle(OUT(O.ROOM_ENTER, w().int32(10).string(''), this.now));
    this.state.handle(IN(H.ROOM_READY, undefined, this.now));
    this.state.handle(IN(H.ROOM_USERS, roomUsers([
      { id: ME.id, name: ME.name, roomIndex: 1, x: 0, y: 0 },
      { id: 200, name: 'Alvo', roomIndex: 2, x: 5, y: 5 },
    ]), this.now));
    this.state.handle(IN(H.ROOM_DATA, roomData({ roomId: 10, name: 'Sala' }), this.now));
  }

  tick(config: FollowConfig, enabled = true): void {
    const t: EngineTick<FollowConfig> = {
      now: this.now, enabled, agentReady: true, config, snapshot: this.state.snapshot(), state: this.state, actions: this.actions, log: (m) => this.logs.push(m),
    };
    this.engine.tick(t);
  }

  /** O servidor nos coloca em (x, y) (1640 sem /mv = parado). */
  meAt(x: number, y: number): void {
    this.state.handle(IN(H.UNIT_STATUS, unitStatuses([{ roomIndex: 1, x, y, actions: '/flatctrl 0//' }]), this.now));
  }

  targetAt(x: number, y: number, moving?: { x: number; y: number }): void {
    this.state.handle(IN(H.UNIT_STATUS, unitStatuses([{ roomIndex: 2, x, y, actions: moving ? `/flatctrl 0/mv ${moving.x},${moving.y},0.0//` : '/flatctrl 0//' }]), this.now));
  }

  walks(): [number, number][] {
    return this.sends.byHeader(O.WALK_TO).map((p) => { const r = p.reader(); return [r.int32(), r.int32()]; });
  }
}

let world: World;
beforeEach(() => { world = new World(); });

describe('geometria', () => {
  it('tileDistance é Chebyshev e approachTiles ordena as 8 vizinhas pela proximidade de quem anda', () => {
    expect(tileDistance({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(1);
    expect(tileDistance({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe(3);
    const tiles = approachTiles({ x: 5, y: 5 }, { x: 0, y: 0 });
    expect(tiles).toHaveLength(8);
    expect(tiles[0]).toEqual({ x: 4, y: 4 }); // a mais perto de (0,0)
    expect(tiles[7]).toEqual({ x: 6, y: 6 }); // a mais longe
    expect(approachTiles({ x: 5, y: 5 }, null)).toHaveLength(8);
  });

  it('com as 8 casas em volta ocupadas, rankApproachTiles oferece o segundo anel (16 casas a 2 de distância)', () => {
    const occupied = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) occupied.add(`${5 + dx},${5 + dy}`);
    const ranked = rankApproachTiles({ x: 5, y: 5 }, { x: 0, y: 0 }, { walkable: new Set(), occupied, blocked: new Set() });
    expect(ranked).toHaveLength(16 + 8);
    expect(ranked[0]).toEqual({ tile: { x: 3, y: 3 }, score: 1 });
    expect(ranked.slice(0, 16).every((r) => tileDistance(r.tile, { x: 5, y: 5 }) === 2)).toBe(true);
    expect(approachTiles({ x: 5, y: 5 }, null, 2)).toHaveLength(16);
  });

  it('rankApproachTiles põe piso conhecido e livre primeiro, ocupadas e bloqueadas por último', () => {
    const ranked = rankApproachTiles({ x: 5, y: 5 }, { x: 0, y: 0 }, {
      walkable: new Set(['5,4']),
      occupied: new Set(['4,4']),
      blocked: new Set(['4,5']),
    });
    expect(ranked[0]).toEqual({ tile: { x: 5, y: 4 }, score: 0 });
    expect(ranked.slice(-2).map((r) => r.score)).toEqual([2, 2]);
    expect(ranked.slice(-2).map((r) => `${r.tile.x},${r.tile.y}`).sort()).toEqual(['4,4', '4,5']);
  });
});

describe('FollowEngine — ir até (once)', () => {
  it('anda até a casa vizinha mais próxima e termina ao chegar', () => {
    const cfg: FollowConfig = { target: 'alvo', mode: 'once' };
    world.tick(cfg);
    expect(world.walks()).toEqual([[4, 4]]);
    world.now += 600;
    world.meAt(4, 4);
    world.tick(cfg);
    expect(world.engine.finished).toBe(true);
    expect(world.logs.at(-1)).toMatch(/Chegou ao lado de Alvo/);
  });

  it('se o servidor não nos move em 700 ms, marca a casa como bloqueada e tenta a próxima', () => {
    const cfg: FollowConfig = { target: 'Alvo', mode: 'once' };
    world.tick(cfg);
    expect(world.walks()).toEqual([[4, 4]]);
    world.now += 400; // ainda dentro da folga
    world.tick(cfg);
    expect(world.walks()).toHaveLength(1);
    world.now += 400; // 800 ms sem 1640 nosso: travados
    world.tick(cfg);
    expect(world.walks()).toHaveLength(2);
    expect(world.walks()[1]).not.toEqual([4, 4]);
  });

  it('evita casas ocupadas e, ao travar, prefere piso onde já viu alguém pisar', () => {
    // Alguém parado em (4,4), a casa que seria a primeira escolha, e alguém em (5,4).
    world.state.handle(IN(H.ROOM_USERS, roomUsers([
      { id: 400, name: 'Bloqueio', roomIndex: 4, x: 4, y: 4 },
      { id: 401, name: 'Passante', roomIndex: 5, x: 5, y: 4 },
    ]), world.now));
    const cfg: FollowConfig = { target: 'alvo', mode: 'pin' };
    world.tick(cfg);
    expect(world.walks()).toEqual([[4, 5]]); // pula as duas ocupadas
    // O passante sai para (9,9): (5,4) vira piso conhecido e livre. Travamos em (4,5) por 800 ms.
    world.state.handle(IN(H.UNIT_STATUS, unitStatuses([{ roomIndex: 5, x: 9, y: 9, actions: '/flatctrl 0//' }]), world.now));
    world.now += 800;
    world.tick(cfg);
    expect(world.walks().at(-1)).toEqual([5, 4]); // piso conhecido antes das desconhecidas
  });
  it('alvo fora da sala: termina avisando', () => {
    world.tick({ target: 'Ninguem', mode: 'once' });
    expect(world.engine.finished).toBe(true);
    expect(world.logs.at(-1)).toMatch(/não está nesta sala/);
  });
});

describe('FollowEngine — segundo anel', () => {
  it('com o primeiro anel cheio de gente, vai para a casa a duas de distância e conclui ao chegar', () => {
    const others = [] as { id: number; name: string; roomIndex: number; x: number; y: number }[];
    let idx = 10;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) others.push({ id: 1000 + idx, name: 'Amigo' + idx, roomIndex: idx++, x: 5 + dx, y: 5 + dy });
    world.state.handle(IN(H.ROOM_USERS, roomUsers(others), world.now));
    const cfg: FollowConfig = { target: 'alvo', mode: 'once' };
    world.tick(cfg);
    expect(world.walks()).toEqual([[3, 3]]);
    world.now += 600;
    world.meAt(3, 3);
    world.tick(cfg);
    expect(world.engine.finished).toBe(true);
    expect(world.logs.at(-1)).toMatch(/Chegou perto de Alvo/);
  });
});

describe('FollowEngine — fixar (pin)', () => {
  const cfg: FollowConfig = { target: 'alvo', mode: 'pin' };

  it('refaz o caminho quando o alvo anda (usa o destino do /mv) e olha para ele ao chegar', () => {
    world.tick(cfg);
    expect(world.walks()).toEqual([[4, 4]]);
    world.now += 600;
    world.meAt(4, 4);
    world.tick(cfg);
    expect(world.engine.finished).toBe(false);
    expect(world.sends.byHeader(O.LOOK_TO)).toHaveLength(1);
    // alvo sai andando de (6,6) para (7,7): o /mv é só o próximo passo, então perseguimos um passo
    // além dele no mesmo rumo, (8,8), sem pisar na casa dele nem na do passo
    world.now += 600;
    world.targetAt(6, 6, { x: 7, y: 7 });
    world.tick(cfg);
    const last = world.walks().at(-1)!;
    expect(tileDistance({ x: last[0], y: last[1] }, { x: 8, y: 8 })).toBe(1);
    expect(last).not.toEqual([7, 7]);
    expect(last).not.toEqual([6, 6]);
  });

  it('ao lado do alvo, só anda de novo quando o passo dele nos deixaria longe; reage em 200 ms', () => {
    world.tick(cfg);
    world.now += 600;
    world.meAt(4, 4);
    world.tick(cfg);
    const before = world.walks().length;
    // passo do alvo de (5,5) para (5,4): continuamos vizinhos, nada a fazer
    world.now += 300;
    world.targetAt(5, 5, { x: 5, y: 4 });
    world.tick(cfg);
    expect(world.walks()).toHaveLength(before);
    // passo de (5,4) para (6,3): sairia do nosso alcance, então acompanhamos na hora
    world.now += 300;
    world.targetAt(5, 4, { x: 6, y: 3 });
    world.tick(cfg);
    expect(world.walks()).toHaveLength(before + 1);
  });

  it('não repete o andar enquanto ainda estamos andando ou o alvo não mudou', () => {
    world.tick(cfg);
    world.now += 600;
    world.state.handle(IN(H.UNIT_STATUS, unitStatuses([{ roomIndex: 1, x: 1, y: 1, actions: '/flatctrl 0/mv 2,2,0.0//' }]), world.now));
    world.tick(cfg);
    world.now += 600;
    world.tick(cfg);
    expect(world.walks()).toHaveLength(1);
  });

  it('alvo saiu da sala: dá follow (3997 se amigo, senão :follow) a cada 8 s', () => {
    world.state.handle(IN(H.UNIT_REMOVE, unitRemove(2), world.now));
    world.tick(cfg);
    expect(world.sends.byHeader(O.CHAT).map((p) => p.reader().string())).toEqual([':follow alvo']);
    world.now += 3000;
    world.tick(cfg);
    expect(world.sends.byHeader(O.CHAT)).toHaveLength(1); // ainda no intervalo
    world.now += 6000;
    world.tick(cfg);
    expect(world.sends.byHeader(O.CHAT)).toHaveLength(2);

    const w2 = new World();
    w2.state.handle(IN(H.ROOM_USERS, roomUsers([{ id: 300, name: 'Amiga', roomIndex: 3, x: 2, y: 2 }]), w2.now));
    w2.state.handle(IN(H.UNIT_REMOVE, unitRemove(3), w2.now));
    w2.tick({ target: 'amiga', mode: 'pin' });
    expect(w2.sends.byHeader(O.FOLLOW_FRIEND).map((p) => p.reader().int32())).toEqual([300]);
  });

  it('trocar o alvo reinicia; desligar limpa', () => {
    world.tick(cfg);
    world.now += 600;
    world.tick({ target: 'outro', mode: 'once' });
    expect(world.engine.finished).toBe(true); // 'outro' não está na sala
    world.tick(cfg, false);
    world.tick(cfg);
    expect(world.engine.finished).toBe(false);
  });
});
