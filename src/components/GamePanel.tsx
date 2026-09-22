import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { GameSnapshot, GameEvent, GameState } from '../protocol/state/GameState';
import RoomPaste from './RoomPaste';
import { pasteSession } from './pasteSession';
import type { GameActions } from '../protocol/actions';
import { Button, Chip, Dot, EmptyState, Eyebrow, FormRow, Input, SegmentedTabs } from './ui';
import { cx } from './cx';
import { cleanName, fmtTime } from './text';
import { postureSpots } from '../addons/protocol/postureEngine';
import { buildRoomCopy, describeRoomCopy, roomCopyFileName } from '../protocol/roomCopy';
import type { FurniCatalog, WallCatalog } from '../../shared/furnidata';

export interface GamePanelProps {
  game: GameSnapshot;
  actions: GameActions;
  agentReady: boolean;
  /** Catálogo do furnidata, para contar os mobis sentáveis/deitáveis da sala e nomear os mobis na cópia. */
  furniCatalog?: FurniCatalog | null;
  wallCatalog?: WallCatalog | null;
  /** GameState vivo (o motor de colar quarto lê o snapshot no próprio relógio). */
  state?: GameState;
  showToast: (msg: string) => void;
}

function describeEvent(e: GameEvent): { text: string; color: string } {
  switch (e.kind) {
    case 'me': return { text: `Logado como ${e.me.name} (id ${e.me.id})`, color: 'text-violet' };
    case 'room-enter': return { text: `Entrou no quarto ${e.roomId ?? '?'}`, color: 'text-violet' };
    case 'room-forward': return { text: `Servidor encaminhou para o quarto ${e.roomId} (seguir amigo)`, color: 'text-violet' };
    case 'follow-sent': return { text: `↑ seguindo ${e.userName ?? 'id ' + e.userId} até o quarto dele`, color: 'text-warn' };
    case 'walk-sent': return { text: `↑ andar até (${e.x}, ${e.y})`, color: 'text-warn' };
    case 'room-leave': return { text: e.reason === 'kicked' ? `Saiu do quarto ${e.name ?? e.roomId ?? '?'} (expulso ou saída manual)` : `Saindo do quarto ${e.name ?? e.roomId ?? '?'}`, color: e.reason === 'kicked' ? 'text-danger' : 'text-violet' };
    case 'room-enter-error': return { text: `Entrada recusada no quarto ${e.roomId ?? '?'} (${e.reason === 1 ? 'cheio' : e.reason === 4 ? 'banido' : 'motivo ' + e.reason})`, color: 'text-danger' };
    case 'user-enter': return { text: `→ ${e.user.name} entrou (idx ${e.user.roomIndex}, id ${e.user.id})`, color: 'text-success' };
    case 'user-leave': return { text: `← ${e.name ?? 'idx ' + e.roomIndex} saiu`, color: 'text-dim' };
    case 'chat': return { text: `${e.whisper ? '(sussurro) ' : e.shout ? '(grito) ' : ''}${e.name ?? 'idx ' + e.roomIndex}: ${e.text}`, color: 'text-fg-2' };
    case 'friend-request': return { text: `★ ${e.request.name} pediu sua amizade (id ${e.request.requestId})`, color: 'text-warn' };
    case 'friend-added': return { text: `✔ ${e.friend.name} virou amigo (id ${e.friend.id})`, color: 'text-success' };
    case 'respect': return { text: `♥ ${e.name ?? 'id ' + e.userId} recebeu respeito (${e.respects} no total)`, color: 'text-success' };
    case 'profile': return { text: `perfil de ${e.name} (id ${e.userId}, ${e.online ? 'online' : 'offline'}): ${e.figure}`, color: 'text-violet' };
    case 'figure': return { text: `✔ visual trocado (${e.gender}): ${e.figure}`, color: 'text-success' };
    case 'group-join-failed': return { text: `✖ entrada no grupo recusada (motivo ${e.reason})`, color: 'text-danger' };
    case 'friend-removed': return { text: `✖ amigo removido (id ${e.id})`, color: 'text-danger' };
    case 'console': return { text: `✉ console de ${e.senderName ?? 'id ' + e.senderId}: ${e.text}`, color: 'text-violet' };
    case 'console-sent': return { text: `↑ console para ${e.userName ?? 'id ' + e.userId}: ${e.text}`, color: 'text-warn' };
    case 'chat-sent': return { text: e.whisperTo ? `↑ sussurro para ${e.whisperTo}: ${e.text}` : `↑ você: ${e.text}`, color: 'text-warn' };
    case 'friend-request-sent': return { text: `↑ pedido de amizade enviado para ${e.name}`, color: 'text-warn' };
    case 'friends-accepted-sent': return { text: `↑ aceitou ${e.ids.length} pedido(s): ${e.ids.join(', ')}`, color: 'text-warn' };
    case 'dialog': return { text: `Aviso do servidor: ${e.strings.slice(0, 2).join(' — ')}`, color: 'text-warn' };
    case 'notice': return { text: `Aviso: ${e.text}`, color: 'text-warn' };
    case 'purchase': return { text: `✔ compra aceita: ${e.name} (oferta ${e.offerId})`, color: 'text-success' };
    case 'unseen-items': return { text: `${e.ids.length} item(ns) novo(s) no inventário`, color: 'text-success' };
    case 'inventory': return { text: `inventário carregado: ${e.count} mobi(s)`, color: 'text-violet' };
    case 'decode-error': return { text: `erro ao decodificar header ${e.header}: ${e.message}`, color: 'text-danger' };
  }
}

type EventFilter = 'all' | 'chat' | 'friends' | 'room';

/** Depois de pedir a porta e as casas ocupadas (3559/1687), quanto esperar as respostas antes de gravar a cópia. */
const COPY_WAIT_MS = 900;

function download(name: string, content: string, type = 'application/json') {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function GamePanel({ game, actions, agentReady, furniCatalog = null, wallCatalog = null, state, showToast }: GamePanelProps) {
  const [copying, setCopying] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  // Assina a sessão de colagem só para o botão refletir o andamento com o cartão fechado.
  useSyncExternalStore(pasteSession.subscribe, pasteSession.getVersion, pasteSession.getVersion);
  const pasteStatus = pasteSession.shortStatus;
  // Snapshot mais recente para o timer do "copiar" (o ref é atualizado fora do render, num efeito).
  const latest = useRef({ game, furniCatalog, wallCatalog });
  useEffect(() => {
    latest.current = { game, furniCatalog, wallCatalog };
  }, [game, furniCatalog, wallCatalog]);
  const copyRoom = () => {
    if (game.room.id === null) { showToast('Entre num quarto para copiá-lo'); return; }
    setCopying(true);
    // A porta e as casas ocupadas só chegam a pedido: pede agora e grava quando as respostas tiverem chegado.
    actions.requestRoomLayout();
    setTimeout(() => {
      setCopying(false);
      const cur = latest.current;
      if (cur.game.room.id === null) { showToast('Saiu do quarto antes de copiar'); return; }
      const copy = buildRoomCopy(cur.game, cur.furniCatalog, cur.wallCatalog);
      download(roomCopyFileName(copy), JSON.stringify(copy, null, 2));
      showToast(`Quarto copiado: ${describeRoomCopy(copy)}`);
    }, COPY_WAIT_MS);
  };
  const furni = useMemo(() => {
    const items = game.room.floorItems;
    if (items.length === 0) return null;
    const sit = furniCatalog ? postureSpots(items, furniCatalog, 'sit').size : null;
    const lay = furniCatalog ? postureSpots(items, furniCatalog, 'lay').size : null;
    return { total: items.length, sit, lay };
  }, [game.room.floorItems, furniCatalog]);
  const [friendName, setFriendName] = useState('');
  const [roomIdInput, setRoomIdInput] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [eventFilter, setEventFilter] = useState<EventFilter>('all');

  const users = useMemo(() => {
    const f = userFilter.trim().toLowerCase();
    return game.room.users.filter((u) => u.type === 1 && (!f || u.name.toLowerCase().includes(f)));
  }, [game.room.users, userFilter]);

  const events = useMemo(() => {
    const list = game.events;
    const filtered =
      eventFilter === 'all' ? list
      : eventFilter === 'chat' ? list.filter((e) => e.kind === 'chat' || e.kind === 'chat-sent' || e.kind === 'console' || e.kind === 'console-sent')
      : eventFilter === 'friends' ? list.filter((e) => e.kind.startsWith('friend'))
      : list.filter((e) => e.kind === 'room-enter' || e.kind === 'room-leave' || e.kind === 'room-enter-error' || e.kind === 'room-forward' || e.kind === 'user-enter' || e.kind === 'user-leave' || e.kind === 'dialog' || e.kind === 'walk-sent' || e.kind === 'follow-sent');
    return filtered.slice(-300).reverse();
  }, [game.events, eventFilter]);

  const onlineFriends = game.friends.filter((f) => f.online).length;
  const friendIds = useMemo(() => new Set(game.friends.map((f) => f.id)), [game.friends]);

  const requestFriend = (name: string) => {
    if (!agentReady) { showToast('Agente inativo: carregue o jogo'); return; }
    actions.requestFriend(name);
    showToast(`Pedido enviado para ${name}`);
  };

  return (
    <div className="min-h-0 flex-1 overflow-x-auto text-[11px]">
      <div className="grid h-full min-w-[900px] grid-cols-[minmax(340px,1fr)_minmax(300px,0.85fr)_minmax(320px,1.4fr)]">
        {/* Coluna 1: eu + sala */}
        <div className="flex min-h-0 min-w-0 flex-col border-r border-line">
          <div className="border-b border-line px-3 py-2">
            <Eyebrow>Eu</Eyebrow>
            {game.me ? (
              <div className="truncate text-fg">{game.me.name} <span className="text-dim">id {game.me.id}</span></div>
            ) : (
              <div className="text-dim">aguardando login (pacote 2725)…</div>
            )}
          </div>
          <div className="border-b border-line px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <Eyebrow>Sala</Eyebrow>
              <span className="tnum whitespace-nowrap text-dim" title={furni ? `${furni.total} mobis de chão (pacote 1778)${furni.sit !== null ? ` · ${furni.sit} casa(s) para sentar · ${furni.lay} para deitar` : ' · furnidata ainda não carregado'}` : undefined}>
                {users.length} usuário(s){furni ? ` · ${furni.total} mobis${furni.sit !== null ? ` · ${furni.sit} sentáveis` : ''}` : ''}
              </span>
            </div>
            {game.room.id !== null ? (
              <div className="truncate text-fg" title={game.room.name ?? ''}>
                {cleanName(game.room.name) || 'sem nome ainda'} <span className="text-dim">#{game.room.id}{game.room.ownerName ? ' · ' + game.room.ownerName : ''}</span>
              </div>
            ) : (
              <div className="text-dim">fora de quarto</div>
            )}
            <FormRow className="mt-1.5">
              <Input mono value={roomIdInput} onChange={(e) => setRoomIdInput(e.target.value)} placeholder="id do quarto" className="w-28" />
              <Button disabled={!agentReady} onClick={() => { const id = parseInt(roomIdInput, 10); if (!Number.isNaN(id)) { actions.visitRoom(id); showToast('Entrando no quarto ' + id); } }}>Entrar</Button>
              <Button variant="accent" disabled={!agentReady || game.room.id === null || copying} onClick={copyRoom} title="Grava um JSON com a planta, a porta, a pintura e todos os mobis do quarto (tipo, posição, altura, direção, estado), mais a lista de compras por tipo. Pede a porta ao servidor (3559) antes de gravar.">{copying ? 'copiando…' : 'Copiar quarto'}</Button>
              {state && <Button variant={pasteOpen || pasteStatus ? 'accent' : 'secondary'} onClick={() => setPasteOpen((v) => !v)} title={pasteStatus ? 'Colagem em andamento; ela continua mesmo com o cartão fechado' : 'Reproduz um JSON do Copiar quarto num quarto seu: planta, compras no catálogo, mobis com altura e estado.'}>{pasteStatus ? `Colar quarto · ${pasteStatus}` : 'Colar quarto'}</Button>}
              <Input value={userFilter} onChange={(e) => setUserFilter(e.target.value)} placeholder="filtrar nomes" className="flex-1 basis-28" />
            </FormRow>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {users.length === 0 ? (
              <EmptyState>Nenhum usuário conhecido. Entre num quarto: a lista vem do pacote 374, sem :chooser.</EmptyState>
            ) : (
              <ul>
                {users.map((u) => {
                  const isMe = game.me?.id === u.id;
                  const isFriend = friendIds.has(u.id);
                  const requested = game.requestedNames.has(u.name.toLowerCase());
                  return (
                    <li key={u.roomIndex} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 border-b border-line/40 px-2 py-1 odd:bg-bg/40 hover:bg-raised">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className={cx('min-w-0 truncate', isMe ? 'text-violet' : 'text-fg')} title={u.motto}>{u.name}</span>
                          {u.typing && <span className="shrink-0 text-warn" title="digitando">…</span>}
                          {u.idle && <span className="shrink-0 text-dim" title="ocioso">zz</span>}
                          {u.moveTarget && <span className="tnum shrink-0 text-info" title={`andando para (${u.moveTarget.x}, ${u.moveTarget.y})`}>→({u.moveTarget.x},{u.moveTarget.y})</span>}
                          {u.posture && <Chip>{u.posture === 'sit' ? 'sentado' : 'deitado'}</Chip>}
                          {u.rights === 4 && <Chip tone="violet">dono</Chip>}
                          {u.rights === 1 && <Chip tone="violet">direitos</Chip>}
                          {isFriend && <Chip tone="success">amigo</Chip>}
                          {requested && !isFriend && <Chip tone="warn">pedido</Chip>}
                        </div>
                        <div className="truncate text-[10px] text-dim">
                          id {u.id} · idx {u.roomIndex} · ({u.x},{u.y}){u.lastChat ? ` · "${u.lastChat.text.slice(0, 40)}"` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {!isMe && (
                          <Button size="sm" onClick={() => { actions.walkTo(u.x, u.y); showToast(`Andando até ${u.name}`); }} disabled={!agentReady} title={`Andar até (${u.x}, ${u.y}) — pacote 3320`}>ir até</Button>
                        )}
                        {!isMe && !isFriend && !requested && (
                          <Button size="sm" variant="primary" onClick={() => requestFriend(u.name)} disabled={!agentReady} title="Envia o pacote 3157 direto">+ amigo</Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Coluna 2: amigos + pedidos */}
        <div className="flex min-h-0 min-w-0 flex-col border-r border-line">
          <div className="border-b border-line px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <Eyebrow>Pedidos pendentes</Eyebrow>
              <span className="tnum text-dim">{game.pendingRequests.length}</span>
            </div>
            {game.pendingRequests.length === 0 ? (
              <div className="text-dim">nenhum</div>
            ) : (
              <ul className="mt-1 space-y-1">
                {game.pendingRequests.map((r) => (
                  <li key={r.requestId} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-fg">{r.name} <span className="text-dim">id {r.requestId}</span></span>
                    <Button size="sm" variant="primary" onClick={() => { actions.acceptFriends([r.requestId]); showToast('Aceito: ' + r.name); }} disabled={!agentReady} title="Envia o pacote 137">Aceitar</Button>
                  </li>
                ))}
                {game.pendingRequests.length > 1 && (
                  <li>
                    <Button size="sm" variant="accent" className="w-full" onClick={() => { const ids = game.pendingRequests.map((r) => r.requestId); actions.acceptFriends(ids); showToast(`Aceitos ${ids.length} pedidos`); }} disabled={!agentReady}>Aceitar todos</Button>
                  </li>
                )}
              </ul>
            )}
          </div>
          <div className="border-b border-line px-3 py-2">
            <Eyebrow>Pedir amizade pelo nome</Eyebrow>
            <FormRow className="mt-1">
              <Input value={friendName} onChange={(e) => setFriendName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && friendName.trim()) { requestFriend(friendName.trim()); setFriendName(''); } }} placeholder="nome exato" className="flex-1 basis-32" />
              <Button variant="primary" onClick={() => { if (friendName.trim()) { requestFriend(friendName.trim()); setFriendName(''); } }} disabled={!agentReady}>Pedir</Button>
            </FormRow>
          </div>
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <Eyebrow>Amigos</Eyebrow>
            <span className="tnum truncate text-dim">{onlineFriends} online · {game.friends.length} total{game.friendsLoaded ? '' : ' (carregando)'}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {game.friends.length === 0 ? (
              <EmptyState>Lista vazia. Ela chega no login (pacote 3130); se o app abriu depois do login, recarregue a página do jogo.</EmptyState>
            ) : (
              <ul>
                {game.friends.slice(0, 400).map((f) => (
                  <li key={f.id} className="flex items-center gap-2 border-b border-line/40 px-3 py-1 odd:bg-bg/40" title={f.motto}>
                    <Dot tone={f.online ? 'success' : 'neutral'} />
                    <span className="min-w-0 flex-1 truncate text-fg-2">{f.name}</span>
                    {f.online && (
                      <Button size="sm" onClick={() => { actions.followFriend(f.id); showToast(`Seguindo ${f.name}`); }} disabled={!agentReady} title="Seguir até o quarto dele — pacote 3997; o cliente entra sozinho">seguir</Button>
                    )}
                    <span className="tnum text-[10px] text-dim">{f.id}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Coluna 3: eventos (ou o cartão Colar quarto) */}
        {pasteOpen && state ? (
          <RoomPaste game={game} agentReady={agentReady} showToast={showToast} onClose={() => { setPasteOpen(false); if (pasteSession.engine.active) showToast('A colagem continua em segundo plano'); }} />
        ) : (
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
            <Eyebrow>Eventos</Eyebrow>
            <SegmentedTabs value={eventFilter} onChange={setEventFilter} items={[{ value: 'all', label: 'Tudo' }, { value: 'chat', label: 'Chat' }, { value: 'friends', label: 'Amizades' }, { value: 'room', label: 'Sala' }]} />
            <span className="ml-auto truncate text-[10px] text-dim">{game.decodeErrors > 0 ? `${game.decodeErrors} erro(s) de decodificação` : 'decodificação ok'}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto font-mono">
            {events.length === 0 ? (
              <EmptyState>Sem eventos ainda.</EmptyState>
            ) : (
              events.map((e, i) => {
                const d = describeEvent(e);
                return (
                  <div key={i} className="flex gap-2 border-b border-line/30 px-3 py-0.5 odd:bg-bg/40">
                    <span className="tnum shrink-0 text-dim">{fmtTime(e.t)}</span>
                    <span className={cx('min-w-0 break-words', d.color)}>{d.text}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
