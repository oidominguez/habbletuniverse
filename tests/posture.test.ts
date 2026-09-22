import { beforeEach, describe, expect, it } from 'vitest';
import { GameState } from '../src/protocol/state/GameState';
import { createGameActions } from '../src/protocol/actions';
import type { GameActions } from '../src/protocol/actions';
import { IN as H, OUT as O } from '../src/protocol/nitro/headers';
import { PostureEngine } from '../src/addons/protocol/postureEngine';
import type { PostureConfig, PostureEnv } from '../src/addons/protocol/postureEngine';
import type { FurniCatalog } from '../shared/furnidata';
import { IN, OUT, captureSends, floorItems, roomData, roomUsers, selfInfo, unitRemove, unitStatuses, w } from './helpers';
import type { FloorItemSpec } from './helpers';

const ME = { id: 1, name: 'Eu' };
const CHAIR = 1001;
const BED = 1003;
const catalog: FurniCatalog = {
  [CHAIR]: { name: 'chair_plasto', xdim: 1, ydim: 1, sit: true, lay: false, offerId: 10 },
  [BED]: { name: 'bed_budget', xdim: 2, ydim: 3, sit: false, lay: true, offerId: -1 },
};

/** Reservas compartilhadas entre "contas" (o que o CrowdManager faz por quarto). */
class Claims {
  map = new Map<string, string>();
  env(owner: string, cat: FurniCatalog | null = catalog): PostureEnv {
    return {
      catalog: cat,
      claim: (k) => {
        const cur = this.map.get(k);
        if (cur !== undefined && cur !== owner) return false;
        this.map.set(k, owner);
        return true;
      },
      release: (k) => {
        if (this.map.get(k) === owner) this.map.delete(k);
      },
    };
  }
}

class World {
  state = new GameState();
  sends = captureSends();
  actions: GameActions = createGameActions(this.sends.send, this.state);
  logs: string[] = [];
  now = 50_000;
  engine = new PostureEngine();
  claims = new Claims();

  constructor(items: FloorItemSpec[] = [{ id: 10, spriteId: CHAIR, x: 2, y: 2 }, { id: 11, spriteId: CHAIR, x: 6, y: 6 }, { id: 12, spriteId: BED, x: 9, y: 0 }]) {
    this.state.handle(IN(H.USER_INFO, selfInfo(ME.id, ME.name), this.now));
    this.state.handle(OUT(O.ROOM_ENTER, w().int32(10).string(''), this.now));
    this.state.handle(IN(H.ROOM_READY, undefined, this.now));
    this.state.handle(IN(H.ROOM_USERS, roomUsers([{ id: ME.id, name: ME.name, roomIndex: 1, x: 0, y: 0 }]), this.now));
    this.state.handle(IN(H.ROOM_DATA, roomData({ roomId: 10, name: 'Sala' }), this.now));
    this.state.handle(IN(H.ROOM_FLOOR_ITEMS, floorItems(items), this.now));
  }

  tick(config: PostureConfig = { posture: 'sit' }, enabled = true, env: PostureEnv = this.claims.env('a')): void {
    this.engine.tick({ now: this.now, enabled, agentReady: true, config, snapshot: this.state.snapshot(), actions: this.actions, env, log: (m) => this.logs.push(m) });
  }

  /** O servidor nos coloca em (x, y), parados, com a postura dada. */
  meAt(x: number, y: number, posture: '' | 'sit' | 'lay' = '', moving?: { x: number; y: number }): void {
    const actions = `/flatctrl 0${moving ? `/mv ${moving.x},${moving.y},0.0` : ''}${posture ? `/${posture} 1.0` : ''}//`;
    this.state.handle(IN(H.UNIT_STATUS, unitStatuses([{ roomIndex: 1, x, y, actions }]), this.now));
  }

  walks(): [number, number][] {
    return this.sends.byHeader(O.WALK_TO).map((p) => { const r = p.reader(); return [r.int32(), r.int32()]; });
  }
}

let world: World;
beforeEach(() => { world = new World(); });

describe('PostureEngine — sentar', () => {
  it('anda até a cadeira livre mais perto e termina quando o servidor manda o /sit', () => {
    world.tick();
    expect(world.walks()).toEqual([[2, 2]]);
    expect(world.claims.map.get('2,2')).toBe('a');
    world.now += 800;
    world.meAt(1, 1, '', { x: 2, y: 2 });
    world.tick();
    expect(world.walks()).toHaveLength(1); // ainda andando: não repete
    world.now += 400;
    world.meAt(2, 2, 'sit');
    world.tick();
    expect(world.engine.finished).toBe(true);
    expect(world.engine.status).toMatch(/sentada em \(2, 2\)/);
    expect(world.claims.map.size).toBe(0); // reserva liberada
  });

  it('já sentada: termina na hora sem andar', () => {
    world.meAt(0, 0, 'sit');
    world.tick();
    expect(world.walks()).toEqual([]);
    expect(world.engine.finished).toBe(true);
  });

  it('pula a cadeira ocupada por outra pessoa e a reservada por outra conta; espera vagar e desiste depois de 60 s', () => {
    world.state.handle(IN(H.ROOM_USERS, roomUsers([{ id: 2, name: 'Outro', roomIndex: 2, x: 2, y: 2 }]), world.now));
    world.claims.map.set('6,6', 'b');
    world.tick();
    expect(world.walks()).toEqual([]);
    expect(world.engine.finished).toBe(false);
    expect(world.engine.status).toMatch(/esperando um lugar livre/);
    // a outra conta libera a reserva: anda na próxima verificação
    world.claims.map.delete('6,6');
    world.now += 400;
    world.tick();
    expect(world.walks()).toEqual([[6, 6]]);
    // cenário sem vaga por 60 s: desiste
    const w2 = new World([{ id: 10, spriteId: CHAIR, x: 2, y: 2 }]);
    w2.state.handle(IN(H.ROOM_USERS, roomUsers([{ id: 2, name: 'Outro', roomIndex: 2, x: 2, y: 2 }]), w2.now));
    w2.tick();
    w2.now += 61_000;
    w2.tick();
    expect(w2.engine.finished).toBe(true);
    expect(w2.engine.status).toMatch(/desisti/);
  });

  it('se o servidor não nos move, marca a casa e tenta a próxima', () => {
    world.tick();
    expect(world.walks()).toEqual([[2, 2]]);
    world.now += 500;
    world.tick();
    expect(world.walks()).toHaveLength(1); // dentro da folga
    world.now += 500;
    world.tick();
    expect(world.walks()).toEqual([[2, 2], [6, 6]]);
    expect(world.claims.map.get('2,2')).toBeUndefined();
    expect(world.claims.map.get('6,6')).toBe('a');
    expect(world.logs.some((l) => /casa inalcançável/.test(l))).toBe(true);
  });

  it('chegou na casa mas não sentou em 2 s: era outra coisa; tenta a próxima', () => {
    world.tick();
    world.now += 300;
    world.meAt(2, 2);
    world.tick();
    world.now += 2100;
    world.tick();
    expect(world.walks()).toEqual([[2, 2], [6, 6]]);
  });

  it('parou no meio do caminho (obstáculo): a casa vai para a lista e a próxima é tentada', () => {
    world.tick();
    world.now += 300;
    world.meAt(1, 1);
    world.tick();
    world.now += 1000;
    world.tick();
    expect(world.walks()).toEqual([[2, 2], [6, 6]]);
    expect(world.logs.some((l) => /caminho terminou antes/.test(l))).toBe(true);
  });

  it('sem mobi sentável no quarto, termina avisando', () => {
    const w2 = new World([]);
    w2.tick();
    expect(w2.engine.finished).toBe(true);
    expect(w2.engine.status).toMatch(/nenhum mobi para sentar/);
  });

  it('sem furnidata, aprende com quem já estava sentado e usa a casa quando ela esvazia', () => {
    const env = world.claims.env('a', null);
    world.state.handle(IN(H.ROOM_USERS, roomUsers([{ id: 2, name: 'Outro', roomIndex: 2, x: 2, y: 2 }]), world.now));
    world.state.handle(IN(H.UNIT_STATUS, unitStatuses([{ roomIndex: 2, x: 2, y: 2, actions: '/flatctrl 0/sit 1.0//' }]), world.now));
    world.tick({ posture: 'sit' }, true, env);
    expect(world.walks()).toEqual([]);
    expect(world.engine.finished).toBe(false); // a única casa conhecida está ocupada: espera
    world.state.handle(IN(H.UNIT_REMOVE, unitRemove(2), world.now));
    world.now += 400;
    world.tick({ posture: 'sit' }, true, env);
    expect(world.walks()).toEqual([[2, 2]]);
  });

  it('desligar libera a reserva; trocar de postura recomeça', () => {
    world.tick();
    expect(world.claims.map.size).toBe(1);
    world.tick({ posture: 'sit' }, false);
    expect(world.claims.map.size).toBe(0);
    world.tick({ posture: 'lay' });
    expect(world.walks().at(-1)).toEqual([9, 0]);
  });
});

describe('PostureEngine — deitar e duas contas', () => {
  it('deitar usa a cama (casa mais perto do mobi 2x3)', () => {
    world.tick({ posture: 'lay' });
    expect(world.walks()).toEqual([[9, 0]]);
    world.now += 600;
    world.meAt(9, 0, 'lay');
    world.tick({ posture: 'lay' });
    expect(world.engine.status).toMatch(/deitada/);
  });

  it('duas contas no mesmo quarto escolhem cadeiras diferentes', () => {
    const b = new PostureEngine();
    const bState = new GameState();
    const bSends = captureSends();
    bState.handle(IN(H.USER_INFO, selfInfo(2, 'Ela'), world.now));
    bState.handle(OUT(O.ROOM_ENTER, w().int32(10).string(''), world.now));
    bState.handle(IN(H.ROOM_READY, undefined, world.now));
    bState.handle(IN(H.ROOM_USERS, roomUsers([{ id: 2, name: 'Ela', roomIndex: 2, x: 1, y: 1 }, { id: 1, name: 'Eu', roomIndex: 1, x: 0, y: 0 }]), world.now));
    bState.handle(IN(H.ROOM_FLOOR_ITEMS, floorItems([{ id: 10, spriteId: CHAIR, x: 2, y: 2 }, { id: 11, spriteId: CHAIR, x: 6, y: 6 }]), world.now));
    world.tick();
    b.tick({ now: world.now, enabled: true, agentReady: true, config: { posture: 'sit' }, snapshot: bState.snapshot(), actions: createGameActions(bSends.send, bState), env: world.claims.env('b'), log: () => {} });
    expect(world.walks()).toEqual([[2, 2]]);
    const bWalk = bSends.byHeader(O.WALK_TO)[0].reader();
    expect([bWalk.int32(), bWalk.int32()]).toEqual([6, 6]); // a de (2,2) já estava reservada pela conta a
  });
});
