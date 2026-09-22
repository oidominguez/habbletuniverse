/**
 * Motores por protocolo como classes puras (sem React): uma instância por sessão de jogo.
 * A janela principal usa via hooks (useProtocolAddUserAll / useProtocolEngines); a Multidão
 * instancia um conjunto por conta. Cada `tick` recebe tudo de que precisa — nada fica preso
 * a closures de componente.
 */
import type {
  AddUserAllConfig,
  AutoAcceptConfig,
  AutoReplyWhispersConfig,
  CommandsLoopConfig,
  ConsoleTrackerConfig,
  NudgeEveryoneConfig,
} from '../../../shared/addon-config';
import type { GameEvent, GameState, GameSnapshot } from '../../protocol/state/GameState';
import type { GameActions } from '../../protocol/actions';
import { approachTiles, tileDistance, tileKey } from './tiles';
import type { Tile } from './tiles';
import { PostureEngine } from './postureEngine';

export { approachTiles, tileDistance, tileKey } from './tiles';
export type { Tile } from './tiles';

export interface EngineTick<C> {
  now: number;
  enabled: boolean;
  agentReady: boolean;
  config: C;
  snapshot: GameSnapshot;
  state: GameState;
  actions: GameActions;
  log: (msg: string) => void;
}

export interface Engine<C> {
  tick(t: EngineTick<C>): void;
}

/** Alterna "msg" / "prefixo+msg" a cada envio, para escapar do filtro de repetição do servidor. */
function alternate(counter: { n: number }, message: string, prefix: string): string {
  const text = counter.n % 2 === 0 ? message : `${prefix}${message}`;
  counter.n++;
  return text;
}

/**
 * Lê só os eventos novos do GameState a cada tick. O log dele é limitado (EVENT_CAP) e descarta os
 * mais antigos, então um índice no array não serve: depois de cheio, `events.length` para de crescer
 * e um cursor por índice nunca mais enxerga nada. Usamos o contador total `eventSeq`.
 */
export class EventCursor {
  private seq = 0;

  /** Ignora tudo o que já aconteceu: passa a ler daqui em diante. */
  skipToEnd(s: GameSnapshot): void {
    this.seq = s.eventSeq;
  }

  take(s: GameSnapshot): GameEvent[] {
    let n = s.eventSeq - this.seq;
    if (n < 0) n = s.events.length; // GameState.reset() zerou o contador
    if (n > s.events.length) n = s.events.length; // perdemos alguns: pega o que ainda existe
    this.seq = s.eventSeq;
    return n === 0 ? [] : s.events.slice(s.events.length - n);
  }
}

function myRoomIndex(s: GameSnapshot): number | null {
  if (!s.me) return null;
  const me = s.room.users.find((u) => u.id === s.me!.id);
  return me ? me.roomIndex : null;
}

/* ====================================== Add User All ====================================== */

export interface AddallStats {
  queue: number;
  processing: number;
  done: number;
  ignored: number;
  notAcceptingRequests: number;
  queueNames: string[];
  processingNames: string[];
  doneNames: string[];
  ignoredNames: string[];
  notAcceptingRequestsNames: string[];
}

export const EMPTY_ADDALL_STATS: AddallStats = {
  queue: 0, processing: 0, done: 0, ignored: 0, notAcceptingRequests: 0,
  queueNames: [], processingNames: [], doneNames: [], ignoredNames: [], notAcceptingRequestsNames: [],
};

const STATS_MS = 400;
const DIALOG_WINDOW_MS = 3000;
const NAV_STALE_MS = 60000;
const NAV_WAIT_MS = 6000;
const ENTER_WAIT_MS = 10000;
/** Depois do 2230 "visitar", quanto esperar o cliente mandar o 2312 sozinho antes de mandar o 2312 cru como plano B. */
const VISIT_FALLBACK_MS = 2500;
/** Fora de quarto e com a lista esgotada, quanto esperar antes de ir para o próximo quarto. */
const OUT_OF_ROOM_IDLE_MS = 2000;

interface AutoRoomState {
  phase: 'idle' | 'searching' | 'entering';
  phaseSince: number;
  targetRoomId: number | null;
  /** Já mandamos o 2312 cru como plano B nesta tentativa de entrada. */
  fallbackSent: boolean;
  visited: Set<number>;
  lastNavSearchAt: number;
  lastProgressAt: number;
  lastRoomId: number | null;
  /** Quartos que nos expulsaram ou recusaram a entrada (cheio/banido): fora do ciclo nesta sessão. */
  blocked: Set<number>;
}

interface PendingTarget {
  name: string;
  id: number;
}

/**
 * Sem :chooser, sem clique: lê a sala do GameState (374), filtra amigos / já pedidos / ignorados
 * e envia um 3157 por vez. Quem entra na sala vai para uma lista própria (`backlog`) que sobrevive
 * à saída do quarto: se formos expulsos, ou se a entrada for recusada, a lista continua sendo
 * adicionada de fora (o 3157 é por nome, não depende de estar no quarto).
 *
 * Auto Room: com a lista esgotada por X s, busca quartos (249) e entra no mais cheio ainda não
 * visitado pelo caminho do próprio cliente (2230 "visitar" → 687 → o Nitro manda o 2312), para a
 * interface acompanhar mesmo a partir da visão do hotel; se o cliente não reagir, manda o 2312 cru.
 */
export class AddUserAllEngine implements Engine<AddUserAllConfig> {
  stats: AddallStats = EMPTY_ADDALL_STATS;
  /** Incrementa quando `stats` muda (para o React saber quando re-renderizar). */
  statsVersion = 0;

  private done = new Map<string, number>();
  private notAccepting = new Set<string>();
  private ignoredSeen = new Set<string>();
  /** Fila de pedidos por nome (minúsculo): quem vimos na sala e ainda não pedimos. Persiste fora do quarto. */
  private backlog = new Map<string, PendingTarget>();
  private lastSent: { t: number; name: string } | null = null;
  private cursor = new EventCursor();
  private lastStatsAt = 0;
  private announced = { enabled: false, waitingRoom: false, waitingAgent: false, autoRoom: false };
  private ar: AutoRoomState = {
    phase: 'idle', phaseSince: 0, targetRoomId: null, fallbackSent: false, visited: new Set(),
    lastNavSearchAt: 0, lastProgressAt: 0, lastRoomId: null, blocked: new Set(),
  };

  tick(t: EngineTick<AddUserAllConfig>): void {
    const { now, config, snapshot, state, actions, log } = t;
    const a = this.announced;
    const ar = this.ar;

    if (!t.enabled) {
      a.enabled = a.waitingRoom = a.waitingAgent = a.autoRoom = false;
      ar.phase = 'idle';
      ar.targetRoomId = null;
      ar.fallbackSent = false;
      this.backlog.clear();
      return;
    }
    if (!a.enabled) {
      a.enabled = true;
      ar.lastProgressAt = now;
      log('Add User All (protocolo) ativo: lendo a sala pelo pacote 374 e enviando 3157 direto, sem :chooser nem cliques.');
    }
    if (!t.agentReady) {
      if (!a.waitingAgent) { a.waitingAgent = true; log('Aguardando o agente do webview (carregue o jogo).'); }
      return;
    }
    a.waitingAgent = false;

    // Eventos novos: aceites, expulsão, entrada recusada, diálogos
    for (const ev of this.cursor.take(snapshot)) {
      if (ev.kind === 'friend-added') {
        const key = ev.friend.name.toLowerCase();
        if (this.done.has(key) || snapshot.requestedNames.has(key)) log(`✔ ${ev.friend.name} aceitou o pedido de amizade (id ${ev.friend.id}).`);
      } else if (ev.kind === 'room-leave') {
        if (ev.reason === 'kicked' && ev.roomId !== null) {
          ar.blocked.add(ev.roomId);
          log(`Saímos do quarto ${ev.name ?? '#' + ev.roomId} (expulsão ou saída manual). Ele sai do ciclo; ${this.backlog.size} da lista continuam sendo adicionados de fora.`);
        }
        ar.lastProgressAt = ev.t;
      } else if (ev.kind === 'room-enter-error') {
        const roomId = ev.roomId ?? ar.targetRoomId;
        const why = ev.reason === 1 ? 'cheio' : ev.reason === 4 ? 'banido' : `motivo ${ev.reason}`;
        if (roomId !== null) ar.blocked.add(roomId);
        if (ar.phase === 'entering' && (ev.roomId === null || ev.roomId === ar.targetRoomId)) {
          log(`Auto Room: entrada recusada no quarto #${roomId} (${why}). Pulando para o próximo.`);
          ar.phase = 'idle';
          ar.targetRoomId = null;
          ar.fallbackSent = false;
          ar.lastProgressAt = 0;
        } else {
          log(`Entrada recusada no quarto #${roomId ?? '?'} (${why}).`);
        }
      } else if (ev.kind === 'dialog') {
        const text = ev.strings.join(' ').toLowerCase();
        const last = this.lastSent;
        if (last && ev.t - last.t <= DIALOG_WINDOW_MS && /amizade|amigo|friend/.test(text)) {
          this.notAccepting.add(last.name);
          log(`Usuário não aceita solicitações: ${last.name} — aviso do servidor: "${ev.strings[1] ?? ev.strings[0] ?? ''}".`);
        }
      }
    }

    const ignoreNames = config.ignoreNames ?? [];
    const ignoreSet = new Set(ignoreNames.map((n) => n.toLowerCase()));
    const roomUsers = snapshot.room.users.filter((u) => u.type === 1);
    const inRoom = snapshot.room.id !== null || roomUsers.length > 0;

    for (const u of roomUsers) {
      if (ignoreSet.has(u.name.toLowerCase()) && !this.ignoredSeen.has(u.name)) {
        this.ignoredSeen.add(u.name);
        log(`Ignorado (lista de exclusão): ${u.name}.`);
      }
    }

    // Lista de pedidos: entra quem está na sala e é candidato; sai quem já pedimos, virou amigo, foi ignorado ou não aceita.
    for (const u of state.friendRequestCandidates(ignoreNames)) {
      const key = u.name.toLowerCase();
      if (!this.backlog.has(key)) this.backlog.set(key, { name: u.name, id: u.id });
    }
    for (const [key, tgt] of this.backlog) {
      if (this.done.has(key) || snapshot.requestedNames.has(key) || ignoreSet.has(key) || this.notAccepting.has(tgt.name) || state.isFriend(tgt.id)) {
        this.backlog.delete(key);
      }
    }
    const pending = [...this.backlog.values()];

    if (!inRoom) {
      // Na troca de quarto pedida por nós (fase 'entering') ficamos fora por alguns ms: não é notícia.
      if (!a.waitingRoom && ar.phase !== 'entering') {
        a.waitingRoom = true;
        if (pending.length > 0) log(`Fora de quarto. Continuando a adicionar os ${pending.length} restantes da lista.`);
        else log(config.autoRoom
          ? `Fora de quarto. Auto Room escolhe o próximo em ${OUT_OF_ROOM_IDLE_MS / 1000} s.`
          : 'Fora de quarto. Entre em um quarto (ou ative o Auto Room): a lista de usuários vem do servidor, sem :chooser.');
      }
    } else a.waitingRoom = false;

    const roomId = snapshot.room.id;
    if (roomId !== ar.lastRoomId) {
      ar.lastRoomId = roomId;
      ar.lastProgressAt = now;
      if (roomId !== null) ar.visited.add(roomId);
      if (ar.phase === 'entering' && roomId !== null && roomId === ar.targetRoomId) {
        log(`Auto Room: entrou no quarto ${snapshot.room.name ?? '#' + roomId}.`);
        ar.phase = 'idle';
        ar.targetRoomId = null;
        ar.fallbackSent = false;
      }
    }
    if (pending.length > 0) ar.lastProgressAt = now;

    const interval = Math.max(800, config.protocolIntervalMs ?? 2500);
    const last = this.lastSent;
    if (ar.phase === 'idle' && pending.length > 0 && (!last || now - last.t >= interval)) {
      const target = pending[0];
      const key = target.name.toLowerCase();
      actions.requestFriend(target.name);
      this.done.set(key, target.id);
      this.backlog.delete(key);
      this.lastSent = { t: now, name: target.name };
      ar.lastProgressAt = now;
      log(`Pedido de amizade enviado (protocolo): ${target.name} (id ${target.id}). Restam ${pending.length - 1}${inRoom ? ' na sala' : ' da lista (fora do quarto)'}.`);
    }

    if (config.autoRoom) {
      if (!a.autoRoom) {
        a.autoRoom = true;
        log(`Auto Room (protocolo) ativo: lista esgotada por ${Math.round((config.autoRoomIdleMs ?? 12000) / 1000)} s, troca para o quarto mais cheio ainda não visitado.`);
      }
      this.runAutoRoom(t, this.backlog.size, inRoom);
    } else {
      a.autoRoom = false;
      ar.phase = 'idle';
    }

    if (now - this.lastStatsAt >= STATS_MS) {
      this.lastStatsAt = now;
      const queueNames = [...this.backlog.values()].map((u) => u.name);
      const doneNames = [...this.done.keys()];
      const ignoredNames = [...this.ignoredSeen];
      const narNames = [...this.notAccepting];
      const processing = this.lastSent && now - this.lastSent.t < interval ? [this.lastSent.name] : [];
      this.stats = {
        queue: queueNames.length, processing: processing.length, done: doneNames.length, ignored: ignoredNames.length, notAcceptingRequests: narNames.length,
        queueNames, processingNames: processing, doneNames, ignoredNames, notAcceptingRequestsNames: narNames,
      };
      this.statsVersion++;
    }
  }

  private runAutoRoom(t: EngineTick<AddUserAllConfig>, pendingCount: number, inRoom: boolean): void {
    const { now, config, snapshot, actions, log } = t;
    const ar = this.ar;
    const idleMs = Math.max(3000, config.autoRoomIdleMs ?? 12000);
    const minUsers = Math.max(1, config.autoRoomMinUsers ?? 3);
    const searchCode = (config.autoRoomSearchCode ?? 'hotel_view').trim() || 'hotel_view';

    if (ar.phase === 'entering') {
      const sent = snapshot.roomEnterSent;
      const clientAsked = sent.roomId === ar.targetRoomId && sent.t >= ar.phaseSince;
      if (!clientAsked && !ar.fallbackSent && now - ar.phaseSince > VISIT_FALLBACK_MS && ar.targetRoomId !== null) {
        ar.fallbackSent = true;
        log(`Auto Room: o cliente não pediu a entrada no quarto #${ar.targetRoomId} em ${VISIT_FALLBACK_MS / 1000} s; mandando o 2312 direto.`);
        actions.enterRoom(ar.targetRoomId);
      }
      if (now - ar.phaseSince > ENTER_WAIT_MS) {
        log(`Auto Room: o quarto #${ar.targetRoomId} não abriu em ${ENTER_WAIT_MS / 1000} s; tentando outro.`);
        if (ar.targetRoomId !== null) ar.visited.add(ar.targetRoomId);
        ar.phase = 'idle';
        ar.targetRoomId = null;
        ar.fallbackSent = false;
        ar.lastProgressAt = 0;
      }
      return;
    }

    if (ar.phase === 'searching') {
      const fresh = snapshot.navigatorRooms.length > 0 && ar.lastNavSearchAt > 0 && now - ar.lastNavSearchAt < NAV_WAIT_MS + 1000;
      const timedOut = now - ar.phaseSince > NAV_WAIT_MS;
      if (!fresh && !timedOut) return;
      if (!fresh && timedOut) {
        log('Auto Room: o navegador não respondeu à busca; tentando de novo.');
        ar.phase = 'idle';
        ar.lastProgressAt = 0;
        ar.lastNavSearchAt = 0;
        return;
      }
      this.chooseAndEnter(t, minUsers);
      return;
    }

    // Enquanto houver alguém na lista (dentro ou fora do quarto), não troca de quarto.
    if (pendingCount > 0) return;
    const wait = inRoom ? idleMs : OUT_OF_ROOM_IDLE_MS;
    if (now - ar.lastProgressAt < wait) return;

    const navFresh = snapshot.navigatorRooms.length > 0 && now - ar.lastNavSearchAt < NAV_STALE_MS && ar.lastNavSearchAt > 0;
    if (!navFresh) {
      log(inRoom
        ? `Auto Room: ${Math.round(idleMs / 1000)} s sem ninguém novo. Buscando quartos (${searchCode})…`
        : `Auto Room: fora de quarto e lista esgotada. Buscando quartos (${searchCode})…`);
      actions.navigatorSearch(searchCode);
      ar.lastNavSearchAt = now;
      ar.phase = 'searching';
      ar.phaseSince = now;
      return;
    }
    this.chooseAndEnter(t, minUsers);
  }

  private chooseAndEnter(t: EngineTick<AddUserAllConfig>, minUsers: number): void {
    const { now, snapshot, actions, log } = t;
    const ar = this.ar;
    const current = snapshot.room.id;
    const open = snapshot.navigatorRooms.filter((r) => r.doorMode === 0);
    const eligible = open
      .filter((r) => r.maxUserCount <= 0 || r.userCount < r.maxUserCount)
      .filter((r) => r.userCount >= minUsers && r.roomId !== current && !ar.blocked.has(r.roomId))
      .sort((a, b) => b.userCount - a.userCount);
    const locked = snapshot.navigatorRooms.length - open.length;

    let pick = eligible.find((r) => !ar.visited.has(r.roomId));
    if (!pick && eligible.length > 0) {
      log(`Auto Room: todos os ${eligible.length} quartos elegíveis já foram visitados. Recomeçando o ciclo.`);
      ar.visited.clear();
      if (current !== null) ar.visited.add(current);
      pick = eligible[0];
    }
    if (!pick) {
      log(`Auto Room: nenhum quarto aberto com ${minUsers}+ usuários na busca (${locked} trancados ignorados). Tentando de novo em ${NAV_STALE_MS / 1000} s.`);
      ar.phase = 'idle';
      ar.lastProgressAt = now;
      ar.lastNavSearchAt = 0;
      return;
    }
    log(`Auto Room: entrando em "${pick.name}" (#${pick.roomId}, ${pick.userCount} usuários; ${locked} trancados ignorados).`);
    // Pelo caminho do cliente (2230 visitar → 687 → o Nitro manda o 2312), para a interface acompanhar.
    actions.visitRoom(pick.roomId);
    ar.visited.add(pick.roomId);
    ar.targetRoomId = pick.roomId;
    ar.fallbackSent = false;
    ar.phase = 'entering';
    ar.phaseSince = now;
  }
}

/* ====================================== Auto Message ====================================== */

export class AutoMessageEngine implements Engine<CommandsLoopConfig> {
  private nextCycleAt = 0;
  private idx = 0;
  private nextItemAt = 0;
  private announced = false;

  tick(t: EngineTick<CommandsLoopConfig>): void {
    const { now, config, actions, log } = t;
    if (!t.enabled || !t.agentReady) {
      this.announced = false;
      this.idx = 0;
      this.nextCycleAt = 0;
      return;
    }
    const list = (config.extraCommands ?? []).filter((c) => c.trim());
    if (list.length === 0) return;
    if (!this.announced) {
      this.announced = true;
      log(`Auto Message (protocolo) ativo: ${list.length} item(ns), ciclo a cada ${Math.round((config.extraCommandsIntervalMs ?? 60000) / 1000)} s.`);
      this.nextCycleAt = now;
    }
    if (this.idx === 0 && now < this.nextCycleAt) return;
    if (this.idx > 0 && now < this.nextItemAt) return;
    const text = list[this.idx];
    actions.chat(text);
    log(`Auto Message: enviado "${text}".`);
    this.idx++;
    if (this.idx >= list.length) {
      this.idx = 0;
      this.nextCycleAt = now + Math.max(5000, config.extraCommandsIntervalMs ?? 60000);
    } else {
      this.nextItemAt = now + Math.max(100, config.extraBetweenCommandsMs ?? 2000);
    }
  }
}

/* ================================= Auto Reply to Whispers ================================= */

export class WhisperReplyEngine implements Engine<AutoReplyWhispersConfig> {
  private cursor = new EventCursor();
  private wasEnabled = false;
  private counter = { n: 0 };
  private lastReplyByName = new Map<string, number>();

  tick(t: EngineTick<AutoReplyWhispersConfig>): void {
    const { now, config, snapshot, actions, log } = t;
    if (!t.enabled || !t.agentReady) {
      this.wasEnabled = false;
      return;
    }
    if (!this.wasEnabled) {
      this.wasEnabled = true;
      this.cursor.skipToEnd(snapshot);
      log('Automatically Reply to Whispers (protocolo) ativo: respondendo sussurros pelo pacote 1543, sem ler a tela.');
      return;
    }
    const meIdx = myRoomIndex(snapshot);
    for (const ev of this.cursor.take(snapshot)) {
      if (ev.kind !== 'chat' || !ev.whisper) continue;
      if (meIdx !== null && ev.roomIndex === meIdx) continue;
      if (!ev.name) {
        log(`Sussurro de usuário desconhecido (idx ${ev.roomIndex}) ignorado: nome ainda não veio pelo 374.`);
        continue;
      }
      const last = this.lastReplyByName.get(ev.name) ?? 0;
      if (now - last < 1500) continue;
      const text = alternate(this.counter, config.message || '', config.alternationPrefix ?? '- ');
      if (!text.trim()) continue;
      actions.whisper(ev.name, text);
      this.lastReplyByName.set(ev.name, now);
      log(`Sussurro de ${ev.name}: "${ev.text.slice(0, 60)}" → respondido com "${text}".`);
    }
  }
}

/* ===================================== Console Tracker ===================================== */

export class ConsoleReplyEngine implements Engine<ConsoleTrackerConfig> {
  private cursor = new EventCursor();
  private wasEnabled = false;
  private counter = { n: 0 };
  private lastReplyBySender = new Map<number, number>();

  tick(t: EngineTick<ConsoleTrackerConfig>): void {
    const { now, config, snapshot, actions, log } = t;
    if (!t.enabled || !t.agentReady) {
      this.wasEnabled = false;
      return;
    }
    if (!this.wasEnabled) {
      this.wasEnabled = true;
      this.cursor.skipToEnd(snapshot);
      log('Console Tracker (protocolo) ativo: respondendo mensagens do console pelo pacote 3567, sem abrir janela.');
      return;
    }
    const minGapMs = Math.max(0, (config.minSecondsBetweenRepliesPerUser ?? 20) * 1000);
    for (const ev of this.cursor.take(snapshot)) {
      if (ev.kind !== 'console') continue;
      if (snapshot.me && ev.senderId === snapshot.me.id) continue;
      if (config.respondOnlyToNewMessages !== false && ev.secondsSinceSent > 60) continue;
      const last = this.lastReplyBySender.get(ev.senderId) ?? 0;
      if (now - last < minGapMs) {
        log(`Console de ${ev.senderName ?? 'id ' + ev.senderId} ignorado: já respondido há menos de ${Math.round(minGapMs / 1000)} s.`);
        continue;
      }
      const text = alternate(this.counter, config.message || '', config.alternationPrefix ?? '- ');
      if (!text.trim()) continue;
      actions.consoleMessage(ev.senderId, text);
      this.lastReplyBySender.set(ev.senderId, now);
      log(`Console de ${ev.senderName ?? 'id ' + ev.senderId}: "${ev.text.slice(0, 60)}" → respondido com "${text}".`);
    }
  }
}

/* ======================================= Auto Aceitar ======================================= */

export class AutoAcceptEngine implements Engine<AutoAcceptConfig> {
  private wasEnabled = false;
  private scheduled = new Map<number, number>();

  tick(t: EngineTick<AutoAcceptConfig>): void {
    const { now, config, snapshot, actions, log } = t;
    if (!t.enabled || !t.agentReady) {
      this.wasEnabled = false;
      this.scheduled.clear();
      return;
    }
    if (!this.wasEnabled) {
      this.wasEnabled = true;
      log(`Auto Aceitar (protocolo) ativo: pedidos recebidos são aceitos após ${Math.round((config.delayMs ?? 1500) / 1000)} s (pacote 137).`);
    }
    const ignore = new Set((config.ignoreNames ?? []).map((n) => n.toLowerCase()));
    for (const req of snapshot.pendingRequests) {
      if (ignore.has(req.name.toLowerCase())) continue;
      if (!this.scheduled.has(req.requestId)) this.scheduled.set(req.requestId, now + Math.max(0, config.delayMs ?? 1500));
    }
    const due: { id: number; name: string }[] = [];
    for (const [reqId, at] of this.scheduled) {
      const req = snapshot.pendingRequests.find((r) => r.requestId === reqId);
      if (!req) { this.scheduled.delete(reqId); continue; }
      if (now >= at) due.push({ id: reqId, name: req.name });
    }
    if (due.length > 0) {
      actions.acceptFriends(due.map((d) => d.id));
      for (const d of due) this.scheduled.delete(d.id);
      log(`Auto Aceitar: aceito(s) ${due.map((d) => `${d.name} (id ${d.id})`).join(', ')}.`);
    }
  }
}

/* ====================================== Nudge Everyone ====================================== */

export interface NudgeStats {
  cycleCount: number;
  clickedLastCycle: number;
}

/**
 * "Clica" em cada usuário da sala pelo protocolo, um por vez, em ciclos: reproduz o quarteto que o cliente
 * manda ao clicar num avatar (3301 olhar, 431 tags, 2091 emblemas, 2138 relacionamentos), sem :chooser
 * nem menu na tela.
 *
 * EXPERIMENTAL: numa captura o aviso "X clicou em você!" chegou ao alvo como texto do sistema (1446), o
 * que sugere que o servidor detecta esses pedidos; ainda falta confirmar com marcador (docs/PROTOCOLO.md).
 */
export class NudgeEngine implements Engine<NudgeEveryoneConfig> {
  stats: NudgeStats = { cycleCount: 0, clickedLastCycle: 0 };
  private announced = false;
  /** roomIndex de quem ainda falta clicar neste ciclo. */
  private queue: number[] = [];
  private nextClickAt = 0;
  private nextCycleAt = 0;
  private clicked = 0;

  tick(t: EngineTick<NudgeEveryoneConfig>): void {
    const { now, config, snapshot, actions, log } = t;
    if (!t.enabled || !t.agentReady) {
      this.announced = false;
      this.queue = [];
      this.nextCycleAt = 0;
      return;
    }
    const clickMs = Math.max(100, config.intervalBetweenClicksMs ?? 1000);
    const loopMs = Math.max(500, config.intervalBetweenLoopsMs ?? 5000);
    if (!this.announced) {
      this.announced = true;
      log(`Nudge Everyone (protocolo) ativo: clique = 3301+431+2091+2138, ${clickMs} ms entre cliques, ciclo a cada ${Math.round(loopMs / 1000)} s.`);
    }
    const ignore = new Set((config.ignoreNames ?? []).map((n) => n.toLowerCase()));
    const meId = snapshot.me?.id;
    const users = snapshot.room.users.filter((u) => u.type === 1 && u.id !== meId && !ignore.has(u.name.toLowerCase()));
    if (users.length === 0) {
      this.queue = [];
      return;
    }
    if (this.queue.length === 0) {
      if (now < this.nextCycleAt) return;
      this.queue = users.map((u) => u.roomIndex);
      this.clicked = 0;
    }
    if (now < this.nextClickAt) return;
    while (this.queue.length > 0) {
      const idx = this.queue.shift()!;
      const u = users.find((x) => x.roomIndex === idx);
      if (!u) continue; // saiu da sala no meio do ciclo
      actions.clickUser(u);
      this.clicked++;
      this.nextClickAt = now + clickMs;
      log(`Clicado: ${u.name}.`);
      break;
    }
    if (this.queue.length === 0) {
      this.stats = { cycleCount: this.stats.cycleCount + 1, clickedLastCycle: this.clicked };
      this.nextCycleAt = now + loopMs;
      log(`Ciclo ${this.stats.cycleCount} concluído: ${this.clicked} clicado(s). Próximo em ${Math.round(loopMs / 1000)} s.`);
    }
  }
}

/* ==================================== Seguir / ir até usuário ==================================== */

export interface FollowConfig {
  /** Nick do alvo (comparação sem distinguir maiúsculas). */
  target: string;
  /** `pin`: persegue em tempo real e dá follow quando ele troca de quarto. `once`: anda até ele uma vez e para. */
  mode: 'pin' | 'once';
}

/** Mínimo entre dois pedidos de andar (o servidor aceita re-rotear no meio do caminho). */
const WALK_MIN_MS = 200;
/**
 * Depois de mandar andar, quanto esperar o servidor nos mover (1640 com /mv) antes de concluir que a
 * casa estava bloqueada. O /mv costuma chegar em 100–300 ms; 700 ms dá folga sem travar a perseguição.
 */
const WALK_RETRY_MS = 700;
const FOLLOW_MIN_MS = 8000;
const LOOK_MIN_MS = 2500;
/** `once`: desiste depois de esgotar as casas em volta este número de vezes. */
const ONCE_MAX_ROUNDS = 2;
/** Casa que tentamos e não nos moveu: fica fora da lista por este tempo (mobi, parede ou alguém parado). */
const BLOCKED_TTL_MS = 30_000;
/** Piso aprendido (casas onde alguém pisou). Acima disto é sala gigante ou trocamos de sala: recomeça. */
const WALKABLE_CAP = 4000;

export interface TileKnowledge {
  /** Casas onde já vimos alguém pisar (piso garantido). */
  walkable: ReadonlySet<string>;
  /** Casas com alguém em cima ou prestes a pisar (fora o alvo e nós). */
  occupied: ReadonlySet<string>;
  /** Casas que tentamos e o servidor não nos moveu. */
  blocked: ReadonlySet<string>;
}

export interface RankedTile {
  tile: Tile;
  /** 0 piso conhecido e livre · 1 desconhecida · 2 ocupada ou bloqueada. */
  score: 0 | 1 | 2;
}

/**
 * As 8 casas em volta, da melhor para a pior: piso já visto e livre primeiro, depois as desconhecidas,
 * por último ocupadas/bloqueadas; dentro de cada faixa, a mais perto de nós (ordem de approachTiles).
 * Não decodificamos o heightmap nem os mobis, então o "piso conhecido" vem de observar onde as pessoas
 * pisam — em sala cheia isso cobre quase tudo em segundos.
 */
export function rankApproachTiles(target: Tile, me: Tile | null, k: TileKnowledge): RankedTile[] {
  const score = (t: Tile): 0 | 1 | 2 => {
    const key = tileKey(t);
    if (k.occupied.has(key) || k.blocked.has(key)) return 2;
    return k.walkable.has(key) ? 0 : 1;
  };
  const rank = (radius: number) => approachTiles(target, me, radius)
    .map((tile, i) => ({ tile, i, score: score(tile) }))
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map(({ tile, score }) => ({ tile, score }));
  const ring1 = rank(1);
  // Oito contas em volta da mesma pessoa esgotam o primeiro anel: quem sobra fica no segundo, a duas casas.
  if (ring1[0].score < 2) return ring1;
  return [...rank(2), ...ring1];
}

/**
 * Persegue um usuário pelo protocolo. Lê a posição dele no 1640; se ele está andando, o `/mv` traz só o
 * PRÓXIMO passo, então o ponto de perseguição é um passo além dele na direção do movimento — assim
 * acompanhamos em vez de parar e recomeçar a cada casa. Anda (3320) até a melhor casa vizinha
 * (rankApproachTiles), refaz na hora em que o alvo muda de rumo (quem nos chama roda o tick a cada
 * 1640, não só no relógio), marca como bloqueada a casa que não nos moveu, olha para ele quando chega
 * (3301) e, se ele sumir da sala, dá follow (3997 se amigo; senão `:follow`) a cada 8 s. `once` = só "ir até".
 */
export class FollowEngine implements Engine<FollowConfig> {
  /** `once`: chegou ou desistiu. Quem controla lê e desliga. */
  finished = false;
  /** Situação legível para a interface. */
  status = '';
  private targetKey = '';
  private lastWalkAt = 0;
  private lastLookAt = 0;
  private lastFollowAt = 0;
  private lastChase: Tile | null = null;
  private lastTile: Tile | null = null;
  private lastLookTile: Tile | null = null;
  private lastMyTile: Tile | null = null;
  private rounds = 0;
  private wasEnabled = false;
  private readonly walkable = new Set<string>();
  private readonly blocked = new Map<string, number>();

  tick(t: EngineTick<FollowConfig>): void {
    const { now, config, snapshot, actions, log } = t;
    if (!t.enabled || !t.agentReady || !config.target.trim()) {
      if (this.wasEnabled) this.reset();
      return;
    }
    const key = config.target.trim().toLowerCase();
    if (!this.wasEnabled || key !== this.targetKey) {
      this.reset();
      this.wasEnabled = true;
      this.targetKey = key;
      log(config.mode === 'pin' ? `Fixado em ${config.target}: seguindo em tempo real (e dando follow se trocar de quarto).` : `Indo até ${config.target}.`);
    }
    if (this.finished) return;

    const users = snapshot.room.users;
    this.learnFloor(users, now);

    const meId = snapshot.me?.id;
    const meUnit = meId !== undefined ? users.find((u) => u.id === meId) : undefined;
    const me: Tile | null = meUnit ? { x: meUnit.x, y: meUnit.y } : null;
    const target = users.find((u) => u.type === 1 && u.name.toLowerCase() === key);

    if (!target) {
      this.lastChase = null;
      if (config.mode === 'once') {
        this.finish(`${config.target} não está nesta sala.`, log);
        return;
      }
      if (now - this.lastFollowAt < FOLLOW_MIN_MS) return;
      this.lastFollowAt = now;
      const friend = snapshot.friends.find((f) => f.name.toLowerCase() === key);
      if (friend) {
        actions.followFriend(friend.id);
        this.status = `seguindo ${friend.name} até o quarto dele (3997)`;
      } else {
        actions.chat(`:follow ${config.target.trim()}`);
        this.status = `procurando ${config.target} (:follow)`;
      }
      log(`${config.target} não está na sala: ${this.status}.`);
      return;
    }

    const tpos: Tile = { x: target.x, y: target.y };
    const step = target.moveTarget ? { x: target.moveTarget.x, y: target.moveTarget.y } : null;
    // Ponto de perseguição: parado = onde ele está; andando = um passo além do próximo passo, no rumo dele.
    const chase: Tile = step ? { x: step.x + Math.sign(step.x - tpos.x), y: step.y + Math.sign(step.y - tpos.y) } : tpos;

    // Chegamos: ao lado dele, ou na casa do segundo anel que escolhemos porque o primeiro estava cheio.
    const dist = me ? tileDistance(me, tpos) : Infinity;
    const onSecondRing = !!me && !!this.lastTile && me.x === this.lastTile.x && me.y === this.lastTile.y && dist === 2;
    if (me && (dist <= 1 || onSecondRing)) {
      if (!step && !meUnit?.moveTarget) {
        // Chegamos e ele está parado: olha para ele de vez em quando; no modo `once`, termina.
        if (config.mode === 'once') {
          this.finish(dist <= 1 ? `Chegou ao lado de ${target.name}.` : `Chegou perto de ${target.name} (as casas ao lado estavam ocupadas).`, log);
          return;
        }
        this.status = dist <= 1 ? `ao lado de ${target.name}` : `perto de ${target.name} (segundo anel)`;
        if (now - this.lastLookAt >= LOOK_MIN_MS && (!this.lastLookTile || tileDistance(this.lastLookTile, tpos) >= 1)) {
          this.lastLookAt = now;
          this.lastLookTile = tpos;
          actions.lookTo(target.x, target.y);
        }
        return;
      }
      // Ele está dando um passo que nos mantém ao lado: não precisa andar.
      if (step && tileDistance(me, step) <= 1) return;
    }

    if (now - this.lastWalkAt < WALK_MIN_MS) return;
    const chaseMoved = !this.lastChase || tileDistance(this.lastChase, chase) >= 1;
    const iMoved = !!me && !!this.lastMyTile && (me.x !== this.lastMyTile.x || me.y !== this.lastMyTile.y);
    const walking = !!meUnit?.moveTarget;
    if (!chaseMoved) {
      // Mesmo destino de antes: se ainda estamos andando ou avançamos, espera; se travamos, a casa era ruim.
      if (walking || iMoved) {
        this.lastMyTile = me;
        return;
      }
      if (now - this.lastWalkAt < WALK_RETRY_MS) return;
      if (this.lastTile) this.blocked.set(tileKey(this.lastTile), now + BLOCKED_TTL_MS);
    }

    const occupied = new Set<string>();
    for (const u of users) {
      if (u === target || u.id === meId) continue;
      occupied.add(tileKey(u));
      if (u.moveTarget) occupied.add(tileKey(u.moveTarget));
    }
    occupied.add(tileKey(tpos));
    if (step) occupied.add(tileKey(step));
    const ranked = rankApproachTiles(chase, me, { walkable: this.walkable, occupied, blocked: new Set(this.blocked.keys()) });
    let best = ranked[0];
    if (best.score === 2) {
      // Tudo em volta ocupado ou já tentado: conta uma rodada e libera os bloqueios para tentar de novo.
      this.rounds++;
      if (config.mode === 'once' && this.rounds >= ONCE_MAX_ROUNDS) {
        this.finish(`Não consegui chegar até ${target.name} (casas em volta bloqueadas).`, log);
        return;
      }
      for (const r of ranked) this.blocked.delete(tileKey(r.tile));
      best = ranked.find((r) => !occupied.has(tileKey(r.tile))) ?? best;
    }
    const tile = best.tile;
    actions.walkTo(tile.x, tile.y);
    this.lastWalkAt = now;
    this.lastChase = chase;
    this.lastTile = tile;
    this.lastMyTile = me;
    this.status = step ? `acompanhando ${target.name} (→ ${tile.x}, ${tile.y})` : `andando até (${tile.x}, ${tile.y}) ao lado de ${target.name}`;
  }

  /** Toda casa onde alguém está ou vai pisar é piso; bloqueios vencidos saem. */
  private learnFloor(users: readonly { x: number; y: number; moveTarget: { x: number; y: number } | null }[], now: number): void {
    if (this.walkable.size > WALKABLE_CAP) this.walkable.clear();
    for (const u of users) {
      this.walkable.add(tileKey(u));
      if (u.moveTarget) this.walkable.add(tileKey(u.moveTarget));
    }
    for (const [k, until] of this.blocked) if (until <= now) this.blocked.delete(k);
  }

  private finish(msg: string, log: (m: string) => void): void {
    this.finished = true;
    this.status = msg;
    log(msg);
  }

  private reset(): void {
    this.finished = false;
    this.status = '';
    this.targetKey = '';
    this.lastWalkAt = 0;
    this.lastLookAt = 0;
    this.lastFollowAt = 0;
    this.lastChase = null;
    this.lastTile = null;
    this.lastLookTile = null;
    this.lastMyTile = null;
    this.rounds = 0;
    this.wasEnabled = false;
    this.walkable.clear();
    this.blocked.clear();
  }
}

export interface EngineSet {
  adduserall: AddUserAllEngine;
  automessage: AutoMessageEngine;
  autoreplywhispers: WhisperReplyEngine;
  consoletracker: ConsoleReplyEngine;
  autoaccept: AutoAcceptEngine;
  nudgeeveryone: NudgeEngine;
  /** Seguir / ir até usuário (comando, não addon). */
  follow: FollowEngine;
  /** Sentar / deitar num mobi (comando, não addon). */
  posture: PostureEngine;
}

export function createEngineSet(): EngineSet {
  return {
    adduserall: new AddUserAllEngine(),
    automessage: new AutoMessageEngine(),
    autoreplywhispers: new WhisperReplyEngine(),
    consoletracker: new ConsoleReplyEngine(),
    autoaccept: new AutoAcceptEngine(),
    nudgeeveryone: new NudgeEngine(),
    follow: new FollowEngine(),
    posture: new PostureEngine(),
  };
}
