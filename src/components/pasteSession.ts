/**
 * Sessão do "Colar quarto" fora do React: o motor, o JSON carregado, as opções e o relógio vivem aqui, num
 * singleton de módulo, para que fechar o cartão (ou trocar de aba) não interrompa uma colagem em andamento.
 * O App liga as dependências (GameState, ações, catálogos, log) uma vez; o cartão só assina e desenha.
 */
import type { FurniCatalog, WallCatalog } from '../../shared/furnidata';
import type { GameActions } from '../protocol/actions';
import type { RoomCopy } from '../protocol/roomCopy';
import { DEFAULT_PASTE_OPTIONS, RoomPasteEngine } from '../protocol/roomPaste';
import type { PasteOptions, PastePhase, PasteTick } from '../protocol/roomPaste';
import type { GameState } from '../protocol/state/GameState';

export interface PasteDeps {
  state: GameState;
  actions: GameActions;
  catalog: FurniCatalog | null;
  walls: WallCatalog | null;
  log: (msg: string) => void;
}

const TICK_MS = 100;

export class PasteSession {
  readonly engine = new RoomPasteEngine();
  copy: RoomCopy | null = null;
  fileName = '';
  options: PasteOptions = DEFAULT_PASTE_OPTIONS;
  /** Cresce a cada mudança visível; o cartão usa como store externa. */
  version = 0;

  private deps: PasteDeps | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private last = { status: '', phase: 'idle' as PastePhase, done: -1 };

  /** Atualiza as dependências (chamado pelo App a cada mudança) e garante o relógio rodando. */
  bind(deps: PasteDeps): void {
    this.deps = deps;
    if (this.timer === null) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Para o relógio (só em testes/desmontagem do App). */
  unbind(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.deps = null;
  }

  get bound(): boolean {
    return this.deps !== null;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getVersion = (): number => this.version;

  private notify(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** Tick do motor para chamadas diretas (start/cancel); exige deps ligadas. */
  private tickOf(): PasteTick | null {
    const d = this.deps;
    if (!d) return null;
    return { now: Date.now(), snapshot: d.state.snapshot(), actions: d.actions, catalog: d.catalog, walls: d.walls, log: (m) => d.log('[Colar quarto] ' + m) };
  }

  private tick(): void {
    const t = this.tickOf();
    if (!t) return;
    const e = this.engine;
    if (e.active) e.tick(t);
    if (e.status !== this.last.status || e.phase !== this.last.phase || e.progress.done !== this.last.done) {
      this.last = { status: e.status, phase: e.phase, done: e.progress.done };
      this.notify();
    }
  }

  setCopy(copy: RoomCopy | null, fileName: string): void {
    this.copy = copy;
    this.fileName = fileName;
    const t = this.tickOf();
    if (t && this.engine.active) this.engine.cancel(t);
    this.notify();
  }

  setOptions(update: (o: PasteOptions) => PasteOptions): void {
    this.options = update(this.options);
    this.notify();
  }

  /** Lê inventário e catálogo e para na prévia. Retorna false se as dependências ainda não foram ligadas. */
  start(): boolean {
    const t = this.tickOf();
    if (!t || !this.copy) return false;
    this.engine.start(this.copy, this.options, t);
    this.notify();
    return true;
  }

  confirm(): void {
    this.engine.confirm();
    this.notify();
  }

  cancel(): void {
    const t = this.tickOf();
    if (t) this.engine.cancel(t);
    this.notify();
  }

  /** Resumo curto para mostrar fora do cartão ("colocando mobis 12/80"). */
  get shortStatus(): string | null {
    const e = this.engine;
    if (!e.active) return null;
    const p = e.progress;
    return p.total > 0 ? `${e.phase} ${p.done}/${p.total}` : e.phase;
  }
}

/** A única sessão de colagem da janela. */
export const pasteSession = new PasteSession();
