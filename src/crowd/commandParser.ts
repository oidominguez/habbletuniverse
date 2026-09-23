/**
 * A barra de comando da Multidão: texto → CrowdCommand. Puro (sem React, sem Electron), testado em
 * tests/commandParser.test.ts.
 *
 * Gramática: o primeiro token é o verbo (em português, com sinônimos); o resto são os argumentos. Texto
 * sem verbo conhecido é fala (o caso mais comum); texto começando com `:` é um comando de chat do servidor
 * (`:sit`, `:dance`…) e também vai como fala. Cada comando do painel tem um verbo aqui, então tudo o que
 * a Multidão sabe fazer está a um Enter de distância.
 */
import type { CrowdCommand } from './CrowdManager';

export interface CommandSpec {
  /** Verbo principal, como aparece nas sugestões. */
  verb: string;
  aliases: string[];
  /** Assinatura curta para a sugestão (ex.: `<nick>`). */
  args: string;
  description: string;
  /** Grupo para as pílulas do painel. */
  group: 'fala' | 'movimento' | 'quarto' | 'amizade' | 'postura' | 'visual';
  /** true = não precisa de argumento: a pílula executa na hora em vez de preencher a barra. */
  immediate?: boolean;
  build: (args: string[], rest: string) => CrowdCommand | string;
}

const int = (v: string | undefined) => {
  if (v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

/** Ordem = ordem das sugestões e das pílulas. */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  { verb: 'falar', aliases: ['dizer', 'say'], args: '<texto>', description: 'fala na sala (1314)', group: 'fala', build: (_a, rest) => (rest ? { kind: 'chat', text: rest } : 'falar o quê?') },
  { verb: 'gritar', aliases: ['shout'], args: '<texto>', description: 'grita na sala (2085)', group: 'fala', build: (_a, rest) => (rest ? { kind: 'shout', text: rest } : 'gritar o quê?') },
  { verb: 'sussurrar', aliases: ['sussurro', 'whisper'], args: '<nick> <texto>', description: 'sussurra para alguém (1543)', group: 'fala', build: (a) => (a.length >= 2 ? { kind: 'whisper', nick: a[0], text: a.slice(1).join(' ') } : 'sussurrar <nick> <texto>') },
  { verb: 'console', aliases: ['msg'], args: '<amigo> <texto>', description: 'mensagem no console para um amigo (3567)', group: 'fala', build: (a) => (a.length >= 2 ? { kind: 'console', name: a[0], text: a.slice(1).join(' ') } : 'console <amigo> <texto>') },

  { verb: 'ir', aliases: ['até', 'ir-até', 'goto'], args: '<nick>', description: 'anda até a casa livre ao lado de alguém, uma vez', group: 'movimento', build: (a) => { const n = a.filter((t) => t.toLowerCase() !== 'até').join(' '); return n ? { kind: 'goTo', name: n } : 'ir até quem?'; } },
  { verb: 'fixar', aliases: ['perseguir', 'pin'], args: '<nick>', description: 'persegue alguém em tempo real; se ele trocar de quarto, dá follow', group: 'movimento', build: (_a, rest) => (rest ? { kind: 'pin', name: rest } : 'fixar em quem?') },
  { verb: 'soltar', aliases: ['unpin', 'largar'], args: '', description: 'para de perseguir', group: 'movimento', immediate: true, build: () => ({ kind: 'unpin' }) },
  { verb: 'andar', aliases: ['walk'], args: '<x> <y>', description: 'anda até a casa (x, y) (3320)', group: 'movimento', build: (a) => { const x = int(a[0]), y = int(a[1]); return x !== null && y !== null ? { kind: 'walk', x, y } : 'andar <x> <y>'; } },
  { verb: 'olhar', aliases: ['look'], args: '<x> <y>', description: 'olha para a casa (x, y) (3301)', group: 'movimento', build: (a) => { const x = int(a[0]), y = int(a[1]); return x !== null && y !== null ? { kind: 'look', x, y } : 'olhar <x> <y>'; } },
  { verb: 'clicar', aliases: ['click', 'cutucar'], args: '<nick>', description: 'reproduz o clique no avatar (3301+431+2091+2138)', group: 'movimento', build: (_a, rest) => (rest ? { kind: 'clickUser', name: rest } : 'clicar em quem?') },

  { verb: 'entrar', aliases: ['quarto', 'enter'], args: '<id do quarto>', description: 'entra num quarto pelo id', group: 'quarto', build: (a) => { const id = int(a[0]); return id !== null ? { kind: 'enterRoom', roomId: id } : 'entrar <id do quarto>'; } },
  { verb: 'seguir', aliases: ['follow'], args: '<nick>', description: 'segue alguém até o quarto dele (3997 se for amigo; senão :follow)', group: 'quarto', build: (_a, rest) => (rest ? { kind: 'followFriend', name: rest } : 'seguir quem?') },
  { verb: 'grupo', aliases: ['group'], args: '<id do grupo>', description: 'pede para entrar num grupo (998)', group: 'quarto', build: (a) => { const id = int(a[0]); return id !== null ? { kind: 'joinGroup', groupId: id } : 'grupo <id do grupo>'; } },
  { verb: 'nota', aliases: ['avaliar', 'rate'], args: '', description: 'dá nota ao quarto atual (3582)', group: 'quarto', immediate: true, build: () => ({ kind: 'rateRoom' }) },

  { verb: 'amizade', aliases: ['pedir', 'add'], args: '<nick>', description: 'pede amizade (3157)', group: 'amizade', build: (_a, rest) => (rest ? { kind: 'requestFriend', name: rest } : 'amizade <nick>') },
  { verb: 'aceitar', aliases: ['accept'], args: '', description: 'aceita todos os pedidos pendentes de cada conta (137)', group: 'amizade', immediate: true, build: () => ({ kind: 'acceptPending' }) },
  { verb: 'respeitar', aliases: ['respeito', 'respect'], args: '<nick>', description: 'respeita alguém (2694; cota diária por conta)', group: 'amizade', build: (_a, rest) => (rest ? { kind: 'respect', name: rest } : 'respeitar quem?') },
  { verb: 'convidar', aliases: ['invite'], args: '[todos] [mensagem]', description: 'convida os amigos online para o quarto (1276); "convidar todos" inclui os offline', group: 'amizade', immediate: true, build: (a) => { const all = a[0]?.toLowerCase() === 'todos'; const msg = (all ? a.slice(1) : a).join(' '); return { kind: 'inviteFriends', message: msg || 'Vem pro quarto!', onlineOnly: !all }; } },

  { verb: 'sentar', aliases: ['sit'], args: '', description: 'cada conta procura um lugar para sentar e senta', group: 'postura', immediate: true, build: () => ({ kind: 'posture', posture: 'sit' }) },
  { verb: 'deitar', aliases: ['lay'], args: '', description: 'cada conta procura um lugar para deitar e deita', group: 'postura', immediate: true, build: () => ({ kind: 'posture', posture: 'lay' }) },
  { verb: 'levantar', aliases: ['stand'], args: '', description: 'quem está sentada/deitada dá um passo para uma casa livre', group: 'postura', immediate: true, build: () => ({ kind: 'standUp' }) },
  { verb: 'parar', aliases: ['cancelar'], args: '', description: 'para de procurar lugar (quem já sentou fica)', group: 'postura', immediate: true, build: () => ({ kind: 'cancelPosture' }) },

  { verb: 'visual', aliases: ['copiar', 'look-of'], args: '<nick>', description: 'copia o visual de alguém pelo nick (2249 → 3898 → 2730)', group: 'visual', build: (_a, rest) => (rest ? { kind: 'copyLook', name: rest } : 'visual <nick>') },
  { verb: 'aplicar', aliases: ['figure'], args: '<código do visual>', description: 'aplica uma string de visual (2730)', group: 'visual', build: (_a, rest) => (rest ? { kind: 'setLook', figure: rest } : 'aplicar <código do visual>') },
];

const BY_VERB = new Map<string, CommandSpec>();
for (const s of COMMAND_SPECS) {
  BY_VERB.set(s.verb, s);
  for (const a of s.aliases) BY_VERB.set(a, s);
}

export function findSpec(verb: string): CommandSpec | undefined {
  return BY_VERB.get(verb.toLowerCase());
}

export type ParseResult = { ok: true; command: CrowdCommand; spec: CommandSpec | null } | { ok: false; error: string };

/**
 * Interpreta a linha. Sem verbo conhecido (ou começando com `:`), é fala: o texto vai inteiro no 1314.
 * `/falar ...` força fala mesmo quando a primeira palavra coincide com um verbo ("ir embora" → "/ir embora"?
 * não: "ir" é verbo; use "falar ir embora").
 */
export function parseCrowdCommand(input: string): ParseResult {
  const line = input.trim().replace(/\s+/g, ' ');
  if (!line) return { ok: false, error: 'Digite um comando ou uma frase.' };
  if (line.startsWith(':')) return { ok: true, command: { kind: 'chat', text: line }, spec: null };
  const [head, ...args] = line.split(' ');
  const spec = findSpec(head);
  if (!spec) return { ok: true, command: { kind: 'chat', text: line }, spec: null };
  const rest = args.join(' ');
  const built = spec.build(args, rest);
  if (typeof built === 'string') return { ok: false, error: built };
  return { ok: true, command: built, spec };
}

export interface Suggestion {
  /** O que entra na barra ao escolher (com espaço no fim quando pede argumento). */
  insert: string;
  label: string;
  hint: string;
  spec: CommandSpec | null;
}

/**
 * Sugestões para o que já foi digitado: verbos que começam com o texto (só enquanto ainda se digita a
 * primeira palavra) e comandos de chat do servidor (432) quando o texto começa com `:`. Vazio quando a
 * linha já tem verbo completo e argumentos.
 */
export function suggestCommands(input: string, serverCommands: readonly string[] = [], limit = 8): Suggestion[] {
  const text = input.trimStart();
  if (text.startsWith(':')) {
    const q = text.toLowerCase();
    return serverCommands
      .filter((c) => c.toLowerCase().startsWith(q))
      .slice(0, limit)
      .map((c) => ({ insert: c + ' ', label: c, hint: 'comando de chat do servidor', spec: null }));
  }
  if (text.includes(' ')) {
    // Verbo já digitado: mostra a assinatura dele como lembrete, e mais nada.
    const spec = findSpec(text.split(' ')[0]);
    return spec && spec.args ? [{ insert: spec.verb + ' ', label: `${spec.verb} ${spec.args}`, hint: spec.description, spec }] : [];
  }
  const q = text.toLowerCase();
  const out: Suggestion[] = [];
  for (const s of COMMAND_SPECS) {
    if (!q || s.verb.startsWith(q) || s.aliases.some((a) => a.startsWith(q))) {
      out.push({ insert: s.verb + (s.args ? ' ' : ''), label: s.args ? `${s.verb} ${s.args}` : s.verb, hint: s.description, spec: s });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Frase curta do que um comando faz, para o toast e o log. */
export function describeCommand(c: CrowdCommand): string {
  switch (c.kind) {
    case 'chat': return `falar "${c.text}"`;
    case 'shout': return `gritar "${c.text}"`;
    case 'whisper': return `sussurrar para ${c.nick}`;
    case 'console': return `console para ${c.name}`;
    case 'goTo': return `ir até ${c.name}`;
    case 'pin': return `fixar em ${c.name}`;
    case 'unpin': return 'soltar alvo';
    case 'walk': return `andar até (${c.x}, ${c.y})`;
    case 'look': return `olhar para (${c.x}, ${c.y})`;
    case 'clickUser': return `clicar em ${c.name}`;
    case 'enterRoom': return `entrar no quarto ${c.roomId}`;
    case 'followFriend': return `seguir ${c.name}`;
    case 'joinGroup': return `entrar no grupo ${c.groupId}`;
    case 'rateRoom': return 'dar nota ao quarto';
    case 'requestFriend': return `pedir amizade a ${c.name}`;
    case 'acceptPending': return 'aceitar pendentes';
    case 'respect': return `respeitar ${c.name}`;
    case 'inviteFriends': return c.onlineOnly ? 'convidar amigos online' : 'convidar todos os amigos';
    case 'posture': return c.posture === 'sit' ? 'todas sentadas' : 'todas deitadas';
    case 'standUp': return 'levantar';
    case 'cancelPosture': return 'parar de procurar lugar';
    case 'copyLook': return `copiar o visual de ${c.name}`;
    case 'setLook': return 'aplicar visual';
  }
}
