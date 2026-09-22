/**
 * Motor de postura: "todas sentadas" / "todas deitadas". Lê os mobis do quarto (1778 e atualizações) e o
 * catálogo do furnidata para saber em que casas dá para sentar ou deitar, escolhe a livre mais perto,
 * anda até ela (3320) e espera o servidor pôr `/sit` (ou `/lay`) no nosso 1640 — no Habbo, sentar é só
 * pisar num mobi sentável. Se o servidor não nos move (casa inalcançável), se paramos antes ou se chegamos e
 * não sentou, a casa vai para a lista de bloqueadas e a próxima da fila é tentada.
 *
 * Várias contas no mesmo quarto não disputam a mesma cadeira: cada casa escolhida é reservada via `env.claim`
 * (o CrowdManager guarda as reservas por quarto) e liberada quando a conta desiste ou termina.
 *
 * Sem furnidata (download falhou), o motor ainda aprende: toda casa onde já viu alguém sentado/deitado
 * vira candidata quando esvazia.
 */
import type { FurniCatalog } from '../../../shared/furnidata';
import { furniFootprint } from '../../../shared/furnidata';
import type { FloorItem } from '../../protocol/nitro/parsers';
import type { GameActions } from '../../protocol/actions';
import type { GameSnapshot } from '../../protocol/state/GameState';
import { parseTileKey, tileDistance, tileKey } from './tiles';
import type { Tile } from './tiles';

export type Posture = 'sit' | 'lay';

export interface PostureConfig {
  posture: Posture;
}

export interface PostureEnv {
  /** Catálogo do furnidata (null = indisponível; só o aprendizado por observação funciona). */
  catalog: FurniCatalog | null;
  /** Reserva uma casa para esta conta; false = outra conta já reservou. */
  claim(key: string): boolean;
  release(key: string): void;
}

export interface PostureTick {
  now: number;
  enabled: boolean;
  agentReady: boolean;
  config: PostureConfig;
  snapshot: GameSnapshot;
  actions: GameActions;
  env: PostureEnv;
  log: (msg: string) => void;
}

export interface PostureSpot {
  tile: Tile;
  /** Mobi que dá a postura nesta casa; null quando a casa veio só da observação. */
  item: FloorItem | null;
  name: string;
}

/** Nome de exibição de um mobi (classe do furnidata, sem sufixos numéricos de cor). */
function furniLabel(name: string): string {
  return name.replace(/\*\d+$/, '');
}

/**
 * Casas onde dá para sentar/deitar: cada casa coberta por um mobi sentável/deitável, desde que ele seja o
 * mobi mais alto ali (uma mesa em cima da cadeira anula a cadeira). Mobis fora do catálogo contam como
 * 1x1 para o cálculo do que está por cima.
 */
export function postureSpots(items: readonly FloorItem[], catalog: FurniCatalog | null, posture: Posture): Map<string, PostureSpot> {
  const top = new Map<string, FloorItem>();
  for (const it of items) {
    const info = catalog?.[it.spriteId];
    for (const t of furniFootprint(it, info)) {
      const k = tileKey(t);
      const cur = top.get(k);
      if (!cur || it.z > cur.z || (it.z === cur.z && it.stackHeight >= cur.stackHeight)) top.set(k, it);
    }
  }
  const out = new Map<string, PostureSpot>();
  for (const [k, item] of top) {
    const info = catalog?.[item.spriteId];
    if (!info) continue;
    if (posture === 'sit' ? !info.sit : !info.lay) continue;
    out.set(k, { tile: parseTileKey(k), item, name: furniLabel(info.name) });
  }
  return out;
}

/** Depois de mandar andar, quanto esperar o servidor nos mover antes de concluir que a casa é inalcançável. */
const WALK_RETRY_MS = 900;
/** Andar longo: desiste desta casa se não chegar neste tempo. */
const WALK_MAX_MS = 20_000;
/** Chegou na casa: quanto esperar o `/sit` aparecer (o servidor senta assim que o passo termina). */
const SIT_WAIT_MS = 2_000;
/** Casa que falhou fica fora da lista por este tempo. */
const BLOCKED_TTL_MS = 60_000;
const MAX_TRIES = 12;
const PICK_MIN_MS = 300;
/** Todos os lugares ocupados/reservados: espera este tempo por um livre antes de desistir. */
const WAIT_FREE_MS = 60_000;

const VERB: Record<Posture, { inf: string; done: string }> = {
  sit: { inf: 'sentar', done: 'sentada' },
  lay: { inf: 'deitar', done: 'deitada' },
};

export class PostureEngine {
  /** Sentou/deitou ou desistiu. Quem controla lê e desliga. */
  finished = false;
  status = '';
  private wasEnabled = false;
  private posture: Posture | null = null;
  private roomId: number | null = null;
  private env: PostureEnv | null = null;
  private target: PostureSpot | null = null;
  private targetKey = '';
  private walkAt = 0;
  private arrivedAt = 0;
  private lastMoveAt = 0;
  private lastMyTile: Tile | null = null;
  private lastPickAt = 0;
  private tries = 0;
  /** Desde quando esperamos um lugar livre (todos ocupados/reservados). */
  private waitingSince = 0;
  private readonly blocked = new Map<string, number>();
  private readonly learned = new Set<string>();

  tick(t: PostureTick): void {
    const { now, config, snapshot, actions, env, log } = t;
    this.env = env;
    if (!t.enabled || !t.agentReady) {
      if (this.wasEnabled) this.reset();
      return;
    }
    if (!this.wasEnabled || config.posture !== this.posture) {
      this.reset();
      this.wasEnabled = true;
      this.posture = config.posture;
      this.roomId = snapshot.room.id;
      log(`Procurando um lugar para ${VERB[config.posture].inf}.`);
    }
    if (this.finished) return;
    const posture = this.posture!;
    const verb = VERB[posture];

    if (snapshot.room.id !== this.roomId) {
      // Trocou de quarto: as casas bloqueadas e aprendidas eram do quarto antigo.
      this.dropTarget();
      this.blocked.clear();
      this.learned.clear();
      this.tries = 0;
      this.roomId = snapshot.room.id;
    }
    if (snapshot.room.id === null) {
      this.status = 'fora de quarto';
      return;
    }

    const users = snapshot.room.users;
    const meId = snapshot.me?.id;
    const me = meId !== undefined ? users.find((u) => u.id === meId) : undefined;
    if (!me) {
      this.status = 'aguardando a posição do avatar';
      return;
    }
    for (const u of users) if (u.posture === posture && u.id !== meId) this.learned.add(tileKey(u));

    if (me.posture === posture) {
      this.finish(`${verb.done} em (${me.x}, ${me.y})${this.target ? ` — ${this.target.name}` : ''}`, log);
      return;
    }

    const occupied = new Set<string>();
    for (const u of users) {
      if (u.id === meId) continue;
      occupied.add(tileKey(u));
      if (u.moveTarget) occupied.add(tileKey(u.moveTarget));
    }

    if (this.target) {
      const tile = this.target.tile;
      if (occupied.has(this.targetKey)) {
        this.giveUpTarget(now, 'alguém ocupou a casa', log);
      } else if (me.x === tile.x && me.y === tile.y) {
        if (!this.arrivedAt) this.arrivedAt = now;
        else if (now - this.arrivedAt > SIT_WAIT_MS) this.giveUpTarget(now, `cheguei e o servidor não me pôs para ${verb.inf}`, log);
      } else if (me.moveTarget) {
        this.lastMoveAt = now;
        this.lastMyTile = { x: me.x, y: me.y };
        if (now - this.walkAt > WALK_MAX_MS) this.giveUpTarget(now, 'demorou demais para chegar', log);
      } else {
        const moved = !this.lastMyTile || me.x !== this.lastMyTile.x || me.y !== this.lastMyTile.y;
        if (moved) {
          this.lastMyTile = { x: me.x, y: me.y };
          this.lastMoveAt = now;
        } else if (now - Math.max(this.walkAt, this.lastMoveAt) > WALK_RETRY_MS) {
          this.giveUpTarget(now, this.lastMoveAt > this.walkAt ? 'o caminho terminou antes da casa' : 'o servidor não me moveu (casa inalcançável)', log);
        }
      }
      if (this.target) return;
    }

    if (now - this.lastPickAt < PICK_MIN_MS) return;
    this.lastPickAt = now;
    if (this.tries >= MAX_TRIES) {
      this.finish(`desisti depois de ${MAX_TRIES} tentativas: nenhuma casa para ${verb.inf} deu certo.`, log);
      return;
    }

    const spots = postureSpots(snapshot.room.floorItems, env.catalog, posture);
    for (const k of this.learned) if (!spots.has(k)) spots.set(k, { tile: parseTileKey(k), item: null, name: `casa onde alguém já estava ${verb.done}` });
    const meTile: Tile = { x: me.x, y: me.y };
    const candidates = [...spots.entries()]
      .filter(([k, s]) => !occupied.has(k) && (this.blocked.get(k) ?? 0) <= now && !(s.tile.x === meTile.x && s.tile.y === meTile.y))
      .sort(([, a], [, b]) => tileDistance(a.tile, meTile) - tileDistance(b.tile, meTile) || Math.abs(a.tile.x - meTile.x) + Math.abs(a.tile.y - meTile.y) - (Math.abs(b.tile.x - meTile.x) + Math.abs(b.tile.y - meTile.y)));
    let chosen: [string, PostureSpot] | null = null;
    for (const c of candidates) {
      if (env.claim(c[0])) {
        chosen = c;
        break;
      }
    }
    if (!chosen) {
      if (spots.size === 0) {
        this.finish(env.catalog ? `nenhum mobi para ${verb.inf} neste quarto (${snapshot.room.floorItems.length} mobis conhecidos).` : `sem furnidata: não sei que mobi dá para ${verb.inf}; só as casas onde eu vir alguém ${verb.done} servem.`, log);
        return;
      }
      // Todos ocupados, reservados ou já tentados: espera um vagar (alguém levanta, uma reserva é liberada) antes de desistir.
      if (!this.waitingSince) {
        this.waitingSince = now;
        log(`os ${spots.size} lugares para ${verb.inf} estão ocupados, reservados ou inalcançáveis; esperando um vagar (até ${WAIT_FREE_MS / 1000} s).`);
      } else if (now - this.waitingSince > WAIT_FREE_MS) {
        this.finish(`desisti: os ${spots.size} lugares para ${verb.inf} continuaram ocupados ou inalcançáveis por ${WAIT_FREE_MS / 1000} s.`, log);
        return;
      }
      this.status = `esperando um lugar livre para ${verb.inf} (${spots.size} conhecidos, todos ocupados)`;
      return;
    }
    this.waitingSince = 0;
    const [key, spot] = chosen;
    actions.walkTo(spot.tile.x, spot.tile.y);
    this.target = spot;
    this.targetKey = key;
    this.walkAt = now;
    this.arrivedAt = 0;
    this.lastMoveAt = now;
    this.lastMyTile = meTile;
    this.tries++;
    this.status = `indo ${verb.inf} em ${spot.name} (${spot.tile.x}, ${spot.tile.y})`;
    log(`${this.status}${this.tries > 1 ? ` (tentativa ${this.tries})` : ''}.`);
  }

  private giveUpTarget(now: number, why: string, log: (m: string) => void): void {
    if (!this.target) return;
    log(`${this.target.name} (${this.target.tile.x}, ${this.target.tile.y}) não deu: ${why}; tentando outra casa.`);
    this.blocked.set(this.targetKey, now + BLOCKED_TTL_MS);
    this.dropTarget();
  }

  private dropTarget(): void {
    if (this.target) this.env?.release(this.targetKey);
    this.target = null;
    this.targetKey = '';
    this.arrivedAt = 0;
  }

  private finish(msg: string, log: (m: string) => void): void {
    this.dropTarget();
    this.finished = true;
    this.status = msg;
    log(msg);
  }

  private reset(): void {
    this.dropTarget();
    this.finished = false;
    this.status = '';
    this.wasEnabled = false;
    this.posture = null;
    this.roomId = null;
    this.walkAt = 0;
    this.lastMoveAt = 0;
    this.lastMyTile = null;
    this.lastPickAt = 0;
    this.tries = 0;
    this.waitingSince = 0;
    this.blocked.clear();
    this.learned.clear();
  }
}
