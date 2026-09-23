import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { GameSnapshot, GameEvent, GameState, RoomUserState } from '../protocol/state/GameState';
import RoomPaste from './RoomPaste';
import { pasteSession } from './pasteSession';
import type { GameActions } from '../protocol/actions';
import { Button, Chip, Dot, EmptyState, Eyebrow, Input, SegmentedTabs } from './ui';
import { Avatar } from './Avatar';
import { LiveDot } from './Sky';
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
type SideTab = 'events' | 'friends';

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
  const [sideTab, setSideTab] = useState<SideTab>('events');
  /** Sussurro em andamento: para quem, e o texto. Fica ancorado no rodapé da lista até enviar ou cancelar. */
  const [whisperTo, setWhisperTo] = useState<string | null>(null);
  const [whisperText, setWhisperText] = useState('');
  const whisperRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (whisperTo) whisperRef.current?.focus();
  }, [whisperTo]);

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
  const sendWhisper = () => {
    if (!whisperTo || !whisperText.trim()) return;
    actions.whisper(whisperTo, whisperText.trim());
    showToast(`Sussurro enviado para ${whisperTo}`);
    setWhisperText('');
    setWhisperTo(null);
  };
  /** Copiar o visual de alguém na sala: o 374 já trouxe o código do visual e o sexo; é só o 2730. */
  const copyLook = (u: RoomUserState) => {
    if (!u.figure) { showToast('Visual desconhecido para ' + u.name); return; }
    actions.setFigure(u.sex === 'F' ? 'F' : 'M', u.figure);
    showToast(`Visual de ${u.name} aplicado (2730)`);
  };

  const roomName = game.room.id !== null ? cleanName(game.room.name) || `#${game.room.id}` : null;

  if (pasteOpen && state) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-auto">
        <RoomPaste game={game} agentReady={agentReady} showToast={showToast} onClose={() => { setPasteOpen(false); if (pasteSession.engine.active) showToast('A colagem continua em segundo plano'); }} />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-x-auto text-[12px]">
      <div className="grid h-full min-w-[960px] grid-cols-12">
        {/* Coluna 1: a sala, com ações por pessoa */}
        <div className="col-span-7 flex min-h-0 min-w-0 flex-col border-r border-line">
          <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-5">
            {roomName ? (
              <>
                <span className="truncate text-[13px] font-semibold text-fg" title={game.room.name ?? ''}>{roomName}</span>
                <span className="tnum shrink-0 font-mono text-[11px] text-dim">#{game.room.id}{game.room.ownerName ? ` · ${game.room.ownerName}` : ''}{game.room.isOwner ? ' · seu' : ''}</span>
              </>
            ) : (
              <span className="text-[13px] text-dim">{game.me ? 'fora de quarto' : 'aguardando login (pacote 2725)…'}</span>
            )}
            <span className="flex-1" />
            {furni && (
              <>
                <Chip title="Mobis de chão conhecidos (pacote 1778)">{furni.total} mobis</Chip>
                {furni.sit !== null && <Chip tone="accent" title="Casas livres onde dá para sentar (o que 'Todas sentadas' usa)">{furni.sit} para sentar</Chip>}
                {furni.lay !== null && furni.lay > 0 && <Chip title="Casas livres onde dá para deitar">{furni.lay} para deitar</Chip>}
              </>
            )}
            <span className="h-4 w-px bg-line-strong" />
            <Input mono size="sm" value={roomIdInput} onChange={(e) => setRoomIdInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { const id = parseInt(roomIdInput, 10); if (!Number.isNaN(id) && agentReady) { actions.visitRoom(id); showToast('Entrando no quarto ' + id); } } }} placeholder="id do quarto" className="w-24" />
            <Button size="sm" disabled={!agentReady} onClick={() => { const id = parseInt(roomIdInput, 10); if (!Number.isNaN(id)) { actions.visitRoom(id); showToast('Entrando no quarto ' + id); } }}>Entrar</Button>
          </div>

          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-5">
            <Eyebrow>Na sala</Eyebrow>
            <span className="tnum font-mono text-[11px] text-dim">{users.length}</span>
            <Input size="sm" value={userFilter} onChange={(e) => setUserFilter(e.target.value)} placeholder="filtrar quem está na sala" className="w-48" />
            <span className="flex-1" />
            <Button size="sm" disabled={!agentReady || game.room.id === null || copying} onClick={copyRoom} title="Grava um JSON com a planta, a porta, a pintura e todos os mobis do quarto (tipo, posição, altura, direção, estado), mais a lista de compras por tipo. Pede a porta ao servidor (3559) antes de gravar.">{copying ? 'copiando…' : 'Copiar quarto'}</Button>
            {state && <Button size="sm" variant={pasteOpen || pasteStatus ? 'accent' : 'primary'} onClick={() => setPasteOpen((v) => !v)} title={pasteStatus ? 'Colagem em andamento; ela continua mesmo com o cartão fechado' : 'Reproduz um JSON do Copiar quarto num quarto seu: planta, compras no catálogo, mobis com altura e estado.'}>{pasteStatus ? `Colar quarto · ${pasteStatus}` : 'Colar quarto'}</Button>}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1.5">
            {users.length === 0 ? (
              <EmptyState>Nenhum usuário conhecido. Entre num quarto: a lista vem do pacote 374, sem :chooser.</EmptyState>
            ) : (
              <ul className="space-y-px">
                {users.map((u) => {
                  const isMe = game.me?.id === u.id;
                  const isFriend = friendIds.has(u.id);
                  const requested = game.requestedNames.has(u.name.toLowerCase());
                  return (
                    <li key={u.roomIndex} className="group grid h-[50px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl px-2.5 hover:bg-fg/[0.04]">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={u.name} figure={u.figure} size={28} />
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className={cx('min-w-0 truncate text-[13px] font-semibold', isMe ? 'text-violet' : 'text-fg')} title={u.motto}>{u.name}</span>
                            {u.typing && <Chip tone="warn" title="digitando">digitando…</Chip>}
                            {u.idle && <Chip title="ocioso">ocioso</Chip>}
                            {u.posture && <Chip>{u.posture === 'sit' ? 'sentado' : 'deitado'}</Chip>}
                            {u.rights === 4 && <Chip tone="violet">dono</Chip>}
                            {u.rights === 1 && <Chip tone="violet">direitos</Chip>}
                            {isFriend && <Chip tone="accent">amigo</Chip>}
                            {requested && !isFriend && <Chip tone="warn">pedido enviado</Chip>}
                          </div>
                          <div className="truncate text-[11px] text-dim">
                            <span className="tnum font-mono">({u.x},{u.y})</span>
                            {u.moveTarget && <span className="tnum font-mono text-info" title="andando para"> → ({u.moveTarget.x},{u.moveTarget.y})</span>}
                            {u.lastChat && <> · <span className="text-fg-2">“{u.lastChat.text.slice(0, 48)}”</span></>}
                            {!u.lastChat && u.motto && <> · {u.motto.slice(0, 48)}</>}
                          </div>
                        </div>
                      </div>
                      {!isMe && (
                        <div className="flex items-center gap-1">
                          <RowAction label={`Ir até ${u.name}`} disabled={!agentReady} onClick={() => { actions.walkTo(u.x, u.y); showToast(`Andando até ${u.name}`); }}><IconWalk /></RowAction>
                          <RowAction label={`Sussurrar para ${u.name}`} disabled={!agentReady} active={whisperTo === u.name} onClick={() => { setWhisperTo(whisperTo === u.name ? null : u.name); }}><IconWhisper /></RowAction>
                          <RowAction label={`Respeitar ${u.name} (cota diária)`} disabled={!agentReady} onClick={() => { actions.respect(u.id); showToast(`Respeito enviado a ${u.name}`); }}><IconHeart /></RowAction>
                          <RowAction label={`Copiar o visual de ${u.name}`} disabled={!agentReady} onClick={() => copyLook(u)}><IconCopy /></RowAction>
                          <RowAction label={`Clicar em ${u.name} (3301+431+2091+2138)`} disabled={!agentReady} onClick={() => { actions.clickUser(u); showToast(`Clique em ${u.name}`); }}><IconClick /></RowAction>
                          {!isFriend && !requested && (
                            <Button size="sm" variant="primary" onClick={() => requestFriend(u.name)} disabled={!agentReady} title="Envia o pacote 3157 direto">+ amigo</Button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {whisperTo && (
            <div className="flex h-11 shrink-0 items-center gap-2 border-t border-line px-4 animate-rise">
              <IconWhisper />
              <span className="shrink-0 text-[12px] text-muted">sussurrar para <span className="font-semibold text-fg">{whisperTo}</span></span>
              <Input ref={whisperRef} size="sm" value={whisperText} onChange={(e) => setWhisperText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendWhisper(); if (e.key === 'Escape') setWhisperTo(null); }} placeholder="mensagem (Enter envia, Esc cancela)" className="flex-1" />
              <Button size="sm" variant="primary" onClick={sendWhisper} disabled={!whisperText.trim()}>Sussurrar</Button>
              <Button size="sm" variant="ghost" onClick={() => setWhisperTo(null)}>cancelar</Button>
            </div>
          )}
        </div>

        {/* Coluna 2: pendentes, pedir por nick, e eventos / amigos (ou o cartão Colar quarto) */}
        {(
          <div className="col-span-5 flex min-h-0 min-w-0 flex-col">
            <div className="shrink-0 space-y-2.5 border-b border-line px-5 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Eyebrow>Pedidos pendentes</Eyebrow>
                  <span className={cx('tnum font-mono text-[11px]', game.pendingRequests.length ? 'text-warn' : 'text-dim')}>{game.pendingRequests.length}</span>
                </div>
                {game.pendingRequests.length > 1 && (
                  <Button size="sm" onClick={() => { const ids = game.pendingRequests.map((r) => r.requestId); actions.acceptFriends(ids); showToast(`Aceitos ${ids.length} pedidos`); }} disabled={!agentReady}>Aceitar todos ({game.pendingRequests.length})</Button>
                )}
              </div>
              {game.pendingRequests.length === 0 ? (
                <div className="text-[11.5px] text-dim">nenhum pedido aguardando</div>
              ) : (
                <ul className="max-h-[132px] space-y-1 overflow-y-auto">
                  {game.pendingRequests.map((r) => (
                    <li key={r.requestId} className="flex items-center gap-2.5">
                      <Avatar name={r.name} figure={r.figure} size={24} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{r.name}</span>
                      <span className="tnum font-mono text-[11px] text-dim">{r.requestId}</span>
                      <Button size="sm" variant="primary" onClick={() => { actions.acceptFriends([r.requestId]); showToast('Aceito: ' + r.name); }} disabled={!agentReady} title="Envia o pacote 137">Aceitar</Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-1.5">
                <Input value={friendName} onChange={(e) => setFriendName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && friendName.trim()) { requestFriend(friendName.trim()); setFriendName(''); } }} placeholder="pedir amizade pelo nick exato" className="flex-1" />
                <Button variant="primary" onClick={() => { if (friendName.trim()) { requestFriend(friendName.trim()); setFriendName(''); } }} disabled={!agentReady || !friendName.trim()}>Pedir</Button>
              </div>
            </div>

            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-5">
              <SegmentedTabs
                value={sideTab}
                onChange={setSideTab}
                items={[
                  { value: 'events', label: 'Eventos' },
                  { value: 'friends', label: <>Amigos <span className="tnum font-mono text-[10.5px] text-dim">{onlineFriends}/{game.friends.length}</span></> },
                ]}
              />
              <span className="flex-1" />
              {sideTab === 'events' ? (
                <>
                  <SegmentedTabs value={eventFilter} onChange={setEventFilter} items={[{ value: 'all', label: 'Tudo' }, { value: 'chat', label: 'Chat' }, { value: 'friends', label: 'Amizades' }, { value: 'room', label: 'Sala' }]} />
                  <span className={cx('truncate text-[10.5px]', game.decodeErrors > 0 ? 'text-warn' : 'text-dim')} title="Erros de decodificação nesta sessão">{game.decodeErrors > 0 ? `${game.decodeErrors} erro(s)` : 'decodificação ok'}</span>
                </>
              ) : (
                <span className="truncate text-[10.5px] text-dim">{game.friendsLoaded ? 'lista completa (3130)' : 'carregando a lista…'}</span>
              )}
            </div>

            {sideTab === 'events' ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-1">
                {events.length === 0 ? (
                  <EmptyState>Sem eventos ainda.</EmptyState>
                ) : (
                  events.map((e, i) => {
                    const d = describeEvent(e);
                    return (
                      <div key={i} className="flex gap-3 border-b border-line/60 py-1.5">
                        <span className="tnum shrink-0 font-mono text-[11px] text-dim">{fmtTime(e.t)}</span>
                        <span className={cx('min-w-0 break-words text-[12px]', d.color)}>{d.text}</span>
                      </div>
                    );
                  })
                )}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1.5">
                {game.friends.length === 0 ? (
                  <EmptyState>Lista vazia. Ela chega no login (pacote 3130); se o app abriu depois do login, recarregue a página do jogo.</EmptyState>
                ) : (
                  <ul className="space-y-px">
                    {game.friends.slice(0, 400).map((f) => (
                      <li key={f.id} className="flex h-9 items-center gap-2.5 rounded-xl px-2.5 hover:bg-fg/[0.04]" title={f.motto}>
                        <Avatar name={f.name} figure={f.figure} size={22} dim={!f.online} />
                        {f.online ? <LiveDot size={5} tone="success" /> : <Dot tone="neutral" />}
                        <span className={cx('min-w-0 flex-1 truncate text-[12.5px]', f.online ? 'text-fg' : 'text-muted')}>{f.name}</span>
                        {f.online && (
                          <Button size="sm" onClick={() => { actions.followFriend(f.id); showToast(`Seguindo ${f.name}`); }} disabled={!agentReady} title="Seguir até o quarto dele — pacote 3997; o cliente entra sozinho">seguir</Button>
                        )}
                        <span className="tnum font-mono text-[10.5px] text-dim">{f.id}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Ação por pessoa: botão redondo só com ícone; o rótulo vai no title e no aria-label. */
function RowAction({ label, onClick, disabled, active, children }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cx('flex h-[26px] w-[26px] items-center justify-center rounded-full border transition-colors disabled:pointer-events-none disabled:opacity-40', active ? 'border-accent/60 bg-accent/10 text-accent' : 'border-line text-muted hover:border-line-strong hover:text-fg')}
    >
      {children}
    </button>
  );
}

const ic = 'h-3 w-3';
function IconWalk() { return <svg className={ic} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 4a1 1 0 100-2 1 1 0 000 2zM7 21l3-7 3 3v4M9 10l2-3 3 1 3 3M10 7l-3 4" /></svg>; }
function IconWhisper() { return <svg className={ic} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 12a8 8 0 01-11.6 7.1L4 20l1.1-4.4A8 8 0 1121 12z" /></svg>; }
function IconHeart() { return <svg className={ic} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 21s-7-4.6-7-10a4 4 0 017-2.6A4 4 0 0119 11c0 5.4-7 10-7 10z" /></svg>; }
function IconCopy() { return <svg className={ic} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="9" y="9" width="11" height="11" rx="2" /><path strokeLinecap="round" d="M5 15V6a2 2 0 012-2h9" /></svg>; }
function IconClick() { return <svg className={ic} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 3v3M3 9h3M5 5l2 2M9 9l11 4-5 2-2 5z" /></svg>; }
