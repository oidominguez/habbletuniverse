/**
 * Headers do protocolo Habblet (cliente Nitro, release PRODUCTION-202101271337).
 *
 * Confirmados pelo corpo do pacote em captura real (ver docs/PROTOCOLO.md), salvo onde
 * marcado como NÃO CONFIRMADO — esses vêm da tabela padrão do Nitro e precisam de captura.
 */

/** Cliente → servidor. */
export const OUT = {
  /** `string nome` — pedido de amizade. */
  REQUEST_FRIEND: 3157,
  /** `int32 count`, `int32 userId`… — aceitar pedido(s). */
  ACCEPT_FRIENDS: 137,
  /** `int32 roomId`, `string senha` — entrar em quarto. */
  ROOM_ENTER: 2312,
  /**
   * `int32 roomId`, `int32 enterRoom`, `int32 forward` — dados do quarto. O cliente manda (roomId, 1, 0)
   * logo após entrar e (roomId, 0, 1) para "visitar": o servidor responde 687 e o próprio cliente Nitro
   * cria a sessão e envia o 2312 (fluxo observado após o 160). É o jeito de entrar num quarto com a
   * interface acompanhando, inclusive a partir da visão do hotel.
   */
  GET_GUEST_ROOM: 2230,
  /** `string código` — busca do navegador (`hotel_view`, `official_view`…). */
  NAVIGATOR_SEARCH: 249,
  /** `int32 x`, `int32 y` — olhar para posição. */
  LOOK_TO: 3301,
  /** `int32 x`, `int32 y` — andar até a posição. Confirmado: 1640 mostra `/mv` rumo ao alvo em seguida. */
  WALK_TO: 3320,
  /** `int32 userId` — seguir amigo: o servidor responde ROOM_FORWARD (160) com o quarto dele e o cliente entra sozinho. */
  FOLLOW_FRIEND: 3997,
  /**
   * `int32 userId` — respeitar usuário (RespectUser). Confirmado ao vivo em 17/09/2026: 8 contas → o servidor
   * respondeu 2815 a cada uma e o total do alvo subiu de 8 em 8 (511 → 519 → 527…). Cota diária por conta.
   */
  RESPECT_USER: 2694,
  /** `int32 groupId` — pedir para entrar num grupo (GroupJoin). Tabela padrão do Nitro; NÃO CONFIRMADO em captura. */
  GROUP_REQUEST: 998,
  /** `int32 nota` — dar nota ao quarto atual (RateFlat; o cliente manda 1). NÃO CONFIRMADO em captura. */
  ROOM_LIKE: 3582,
  /** `string gênero` ('M'/'F'), `string visual` — trocar o próprio visual (UserFigure). Confirmado ao vivo em 18/09/2026 (servidor respondeu 2429). */
  USER_FIGURE: 2730,
  /** `string nick` — pedir o perfil de alguém pelo nome; responde 3898 com o visual, mesmo offline. Confirmado ao vivo em 18/09/2026. */
  USER_PROFILE_BY_NAME: 2249,
  /** `int32 count`, `int32 userId`…, `string mensagem` — convidar amigos para o quarto atual (SendRoomInvite). NÃO CONFIRMADO. */
  SEND_ROOM_INVITE: 1276,
  /** `int32 roomIndex` — tags do usuário. */
  GET_USER_TAGS: 431,
  /** `int32 userId` — emblemas selecionados. */
  GET_SELECTED_BADGES: 2091,
  /** `int32 userId` — status de relacionamento. */
  GET_RELATIONSHIPS: 2138,
  /** vazio — pong. */
  PONG: 2596,
  /** vazio — pedir a casa da porta do quarto (GetRoomEntryTile); resposta 1664. O `:floor` do cliente manda este e o 1687. Confirmado em 21/09/2026. */
  GET_ROOM_ENTRY_TILE: 3559,
  /** vazio — pedir as casas ocupadas por mobi (GetOccupiedTiles); resposta 3990. Confirmado em 21/09/2026. */
  GET_OCCUPIED_TILES: 1687,

  /* ---- construção (sessão de marcadores de 21/09/2026, quarto da conta Dominguez) ---- */
  /**
   * `string planta` (linhas por \\r), `int32 portaX`, `int32 portaY`, `int32 portaDireção`, `int32 espessuraParede`,
   * `int32 espessuraPiso`, `int32 alturaParede` (-1 = padrão) — salvar a planta pelo editor (UpdateFloorProperties).
   * O servidor responde com o aviso 3801 e manda reentrar (160 → 2312). Confirmado.
   */
  SAVE_FLOOR_PLAN: 875,
  /**
   * `string` — colocar mobi do inventário no quarto (PlaceObject). Chão: `"id x y direção"`; parede: `"id :w=x,y l=x,y l "`
   * (a posição no formato do cliente, com um espaço no fim). Respostas: 159 (saiu do inventário) e 1534 / 2187. Confirmado.
   */
  PLACE_OBJECT: 1258,
  /** `int32 id`, `int32 x`, `int32 y`, `int32 direção` — mover/girar mobi de chão (MoveObject). Resposta 3776. Com `:up N` / `:state N` ligados, o servidor aplica altura/estado neste movimento. Confirmado. */
  MOVE_OBJECT: 248,
  /** `int32 id`, `int32 0` — usar mobi de chão: avança o estado (UseFurniture). Resposta 2547. Confirmado. */
  USE_OBJECT: 99,
  /** `int32 10`, `int32 id` — pegar mobi de chão de volta para o inventário (PickupObject). Resposta 2703 (com atraso). Confirmado. */
  PICKUP_OBJECT: 3456,
  /** `int32 id`, `string posição` — mover mobi de parede (MoveWallItem). Resposta 2009. Confirmado. */
  MOVE_WALL_ITEM: 168,
  /** `int32 id`, `int32 0` — usar mobi de parede (UseWallItem). Resposta 2009 com o estado novo. Confirmado. */
  USE_WALL_ITEM: 210,
  /** `int32 idDoItem` — aplicar piso/papel de parede/paisagem do inventário ao quarto (ApplyDecoration). Resposta 2454. Confirmado. */
  APPLY_DECORATION: 711,
  /** vazio — pedir a lista do inventário de mobis (RequestFurniInventory). Resposta 994 (em fragmentos). Confirmado. */
  GET_INVENTORY: 3150,
  /** `string modo` ("NORMAL") — pedir o índice do catálogo (GetCatalogIndex). Resposta 1032. Confirmado. */
  GET_CATALOG_INDEX: 1195,
  /** `int32 páginaId`, `int32 ofertaId` (-1), `string modo` ("NORMAL") — pedir uma página do catálogo (GetCatalogPage). Resposta 804. Confirmado. */
  GET_CATALOG_PAGE: 412,
  /** `int32 páginaId`, `int32 ofertaId`, `string dadoExtra`, `int32 quantidade` — comprar (PurchaseFromCatalog). Respostas 869, 2103, 1992. Confirmado. */
  PURCHASE: 3492,

  /** `string texto`, `int32 estilo` — falar na sala (21 B para "oi sem sussurro": sem trackingId). */
  CHAT: 1314,
  /** NÃO CONFIRMADO (padrão Nitro): grito. */
  SHOUT: 2085,
  /** `string "nome texto"`, `int32 estilo` — sussurrar. */
  WHISPER: 1543,
  /** vazio — comecei a digitar. */
  TYPING_START: 1597,
  /** vazio — parei de digitar (enviado junto com a mensagem). */
  TYPING_STOP: 1474,
  /** `int32 userId`, `string texto` — mensagem no console (messenger). */
  CONSOLE_SEND: 3567,
  /** NÃO CONFIRMADO (padrão Nitro): `int32 count`, ids — recusar pedido(s); `bool declineAll` antes. */
  DECLINE_FRIENDS: 2890,
} as const;

/** Servidor → cliente. */
export const IN = {
  /** Dados do próprio usuário (pós-login). */
  USER_INFO: 2725,
  /** Fragmento da lista de amigos (pós-login). */
  FRIENDS_LIST: 3130,
  /** Atualização da lista de amigos: novo amigo, status, missão, sala. */
  FRIENDS_UPDATE: 2800,
  /** Pedido de amizade recebido. */
  FRIEND_REQUEST: 2219,
  /** `int32 userId`, `int32 respeitos` — alguém da sala foi respeitado (RespectReceived). Confirmado em 17/09/2026; chega para todos na sala com o total atualizado. */
  RESPECT_RECEIVED: 2815,
  /** `int32 id`, `string nome`, `string visual`, `string missão`, … — perfil de um usuário (UserProfile). Confirmado em 18/09/2026: id, nome, visual e missão batem. */
  USER_PROFILE: 3898,
  /** `string visual`, `string gênero` — o servidor aceitou a troca do nosso visual (FigureUpdate). Confirmado em 18/09/2026. */
  USER_FIGURE: 2429,
  /** `int32 motivo` — pedido de entrada no grupo recusado (HabboGroupJoinFailed). NÃO CONFIRMADO. */
  GROUP_JOIN_FAILED: 762,
  /** Convite para quarto recebido de um amigo (MessengerInvite). NÃO CONFIRMADO. */
  ROOM_INVITE: 3870,
  /** Erro ao convidar (MessengerInviteError). NÃO CONFIRMADO. */
  ROOM_INVITE_ERROR: 462,
  /** Emblemas selecionados de um usuário. */
  USER_BADGES: 1087,
  /** Relacionamentos de um usuário. */
  RELATIONSHIPS: 2016,

  /** `int32 roomId` — o servidor manda o cliente para um quarto (resposta ao FOLLOW_FRIEND; o cliente faz 2230 → 687 → 2312). */
  ROOM_FORWARD: 160,
  /** vazio — você é dono deste quarto (visto ao entrar no próprio quarto). */
  ROOM_RIGHTS_OWNER: 339,
  /** Quarto pronto para entrar (primeiro pacote após ROOM_ENTER). */
  ROOM_READY: 758,
  /** Vazio — saiu do quarto para a visão do hotel (expulsão, saída ou entrada recusada). Observado após o 2661 do próprio avatar. */
  HOTEL_VIEW: 122,
  /** `int32 código` — erro genérico. 4008 = você foi expulso do quarto (vem antes do 2661 próprio e do 122). */
  GENERIC_ERROR: 1600,
  /** `int32 motivo`, `string parâmetro` — entrada no quarto recusada (1 = cheio, 4 = banido). Vem com 2661 próprio + 122, sem 758. */
  ROOM_ENTER_ERROR: 899,
  /** Dados do quarto (nome, dono, descrição…). */
  ROOM_DATA: 687,
  /** Nome do modelo do quarto. */
  ROOM_MODEL: 2031,
  /** Pintura (floor/wallpaper/landscape). */
  ROOM_PAINT: 2454,
  /** Usuários na sala (lista inicial e chegadas). */
  ROOM_USERS: 374,
  /** Status/movimento dos avatares. */
  UNIT_STATUS: 1640,
  /** Usuário saiu da sala (`string roomIndex`). */
  UNIT_REMOVE: 2661,
  /** Usuário mudou visual/missão. */
  UNIT_INFO: 3920,
  /** Digitando. */
  UNIT_TYPING: 1717,
  /** Ocioso. */
  UNIT_IDLE: 1797,
  /** Efeito do avatar. */
  UNIT_EFFECT: 1167,
  /** Fala na sala. */
  CHAT: 1446,
  /** Grito na sala. */
  SHOUT: 1036,
  /** Sussurro recebido (inclui o eco do próprio sussurro). */
  WHISPER: 2704,
  /** `int32 senderId`, `string texto`, `int32 segundosDesdeEnvio` — mensagem do console recebida. */
  CONSOLE_MESSAGE: 1587,
  /** Custom Habblet: nome colorido / tag do usuário. */
  HABBLET_NAME_TAG: 2182,

  /**
   * Mobis de chão do quarto (ObjectsMessage): `int32 nDonos` (id, nome)…, `int32 n`, por mobi: `int32 id`,
   * `int32 spriteId`, `int32 x`, `int32 y`, `int32 direção`, `string z`, `string altura`, `int32 extra`,
   * `int32 tipoDados` (+ dados), `int32 expira`, `int32 uso`, `int32 donoId` [, `string classe` se spriteId < 0].
   * Confirmado em 20/09/2026 contra 2.757 pacotes reais (1,5 milhão de mobis). Pode vir em vários pacotes por quarto.
   */
  ROOM_FLOOR_ITEMS: 1778,
  /** Um mobi de chão colocado/apareceu (ObjectAdd): a mesma estrutura de um mobi do 1778 + `string donoNome`. Confirmado em 20/09/2026. */
  ROOM_FLOOR_ITEM_ADD: 1534,
  /** `string id`, `bool expirou`, `int32 quemPegou`, `int32 atraso` — mobi de chão removido (ObjectRemove). Confirmado em 20/09/2026. */
  ROOM_FLOOR_ITEM_REMOVE: 2703,
  /** Um mobi de chão movido/girado/atualizado (ObjectUpdate): mesma estrutura de um mobi do 1778. Confirmado em 20/09/2026. */
  ROOM_FLOOR_ITEM_UPDATE: 3776,
  /**
   * Mobis de parede do quarto (ItemsMessage): `int32 nDonos` (id, nome)…, `int32 n`, por mobi: `string id`, `int32 spriteId`,
   * `string posição` (`:w=x,y l=x,y l|r`), `string estado`, `int32 expira`, `int32 uso`, `int32 donoId`. Confirmado em 21/09/2026
   * (1.933 pacotes, 37 mil mobis, 0 erros).
   */
  ROOM_WALL_ITEMS: 1369,
  /** `bool`, `int32 alturaParede`, `string planta` (linhas por \\r; `x` = sem chão), `int32 n` áreas (id, bool, x, y, w, h — significado a confirmar). Confirmado em 21/09/2026. */
  ROOM_FLOOR_PLAN: 1301,
  /** `int32 largura`, `int32 nCasas`, `int16` por casa: (v & 0x3fff) / 256 = altura do topo (piso + mobis); 0x3f3f = sem chão. Confirmado em 21/09/2026. */
  ROOM_HEIGHT_MAP: 2753,
  /** `int32 x`, `int32 y`, `int32 direção` — casa da porta (resposta ao 3559). Confirmado em 21/09/2026. */
  ROOM_ENTRY_TILE: 1664,
  /** `int32 n`, pares `int32 x`, `int32 y` — casas ocupadas por mobi (resposta ao 1687). Confirmado em 21/09/2026. */
  ROOM_OCCUPIED_TILES: 3990,

  /* ---- construção, catálogo e inventário (sessão de marcadores de 21/09/2026) ---- */
  /** Um mobi de parede colocado (ItemAdd): mesma estrutura de um mobi do 1369 + `string donoNome`. Confirmado. */
  ROOM_WALL_ITEM_ADD: 2187,
  /** Um mobi de parede movido/usado (ItemUpdate): mesma estrutura de um mobi do 1369 + `string donoNome`. Confirmado. */
  ROOM_WALL_ITEM_UPDATE: 2009,
  /** `string id`, `bool`, `int32 quemPegou` — mobi de parede removido (ItemRemove). Tabela padrão do Nitro; NÃO CONFIRMADO. */
  ROOM_WALL_ITEM_REMOVE: 3208,
  /** `string id`, `int32 tipoDados` + dados — estado de um mobi de chão mudou (ObjectDataUpdate), resposta ao 99. Confirmado (antes marcado como periódico ?). */
  OBJECT_DATA_UPDATE: 2547,
  /** `string texto`… — aviso do servidor em janela (ex.: "Seu quarto foi modificado com sucesso com o Editor de Chão!"). Confirmado. */
  SERVER_NOTICE: 3801,
  /** Índice do catálogo (CatalogIndex): árvore de páginas com as ofertas de cada uma. Confirmado (1.035 páginas, 28 mil ofertas mapeadas). */
  CATALOG_INDEX: 1032,
  /** Página do catálogo (CatalogPage): ofertas com preço e produtos (spriteId). Confirmado em 27 páginas. */
  CATALOG_PAGE: 804,
  /** Compra aceita (PurchaseOK): `int32 ofertaId`, `string nome`… Confirmado. */
  PURCHASE_OK: 869,
  /** `int32 nCategorias`, por categoria: `int32 categoria`, `int32 n`, ids — itens novos no inventário (UnseenItems). Confirmado. */
  UNSEEN_ITEMS: 2103,
  /** Inventário de mobis (FurniList), em fragmentos: `int32 total`, `int32 índice`, `int32 n`, itens. Confirmado (2.965 itens). */
  INVENTORY: 994,
  /** `int32 idDoItem` — item saiu do inventário (FurniListRemove), ao ser colocado no quarto. Confirmado. */
  INVENTORY_REMOVE: 159,

  /** Resultados da busca do navegador. */
  NAVIGATOR_RESULTS: 2690,
  /** Diálogo/aviso genérico do servidor (título, texto, botão). */
  SERVER_DIALOG: 286,
  /** Custom Habblet: lista de comandos de chat disponíveis. */
  HABBLET_COMMANDS: 432,
  /** Ping do servidor. */
  PING: 3928,
} as const;

/** Tipos de unidade no ROOM_USERS. */
export const UNIT_TYPE = { USER: 1, PET: 2, BOT: 3, RENTABLE_BOT: 4 } as const;
