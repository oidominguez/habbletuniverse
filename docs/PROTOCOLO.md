# Protocolo do Habblet — o que já sabemos

Documento vivo. Registra o que foi observado no tráfego real entre o cliente Nitro do Habblet e o servidor, para sustentar a camada de protocolo do app (decodificadores, API de ações e, depois, a migração dos addons para fora do DOM).

## Sessão de captura de referência

| Item | Valor |
|------|-------|
| Data | 13/09/2026, cerca de 6 minutos de jogo |
| Servidor | `wss://game.habblet.city` (uma única conexão WebSocket) |
| Versão do cliente anunciada | `PRODUCTION-202101271337-HTML5` |
| Criptografia | nenhuma; framing padrão Habbo |
| Pacotes capturados | 4.721 (arquivo NDJSON em `%APPDATA%\habblet-addall\captures\`) |
| Globais expostos pela página | nenhum (`Nitro`, `NitroConfig` etc. não estão em `window`; cliente empacotado) |
| Atividade durante a captura | Add User All por DOM em salas públicas cheias; troca de quarto (A → B → A); aceite manual de um pedido recebido; conversas e movimentação de terceiros. Sem marcadores. |
| Conta usada | nick `DATAPOL`, id `5909416` (aparece no 2725 pós-login e como primeiro registro do 374 ao entrar) |

**Consequência importante:** a versão `PRODUCTION-202101271337` é a base que o Nitro open source usa por padrão. Os números de header observados batem com a tabela padrão do Nitro nos casos que conseguimos confirmar pelo corpo do pacote. Isso permite usar o código do Nitro (`@nitrots/nitro-renderer`, pastas `communication/messages/incoming` e `outgoing`) como referência de estrutura para os pacotes ainda não decodificados.

## Formato do frame

```
int32 length        tamanho de (header + corpo), big-endian
int16 header        identificador do pacote
bytes corpo         primitivos big-endian: int32, int16, byte/boolean, string = int16 tamanho + UTF-8
```

Um frame WebSocket pode trazer vários pacotes concatenados. O agente separa e reporta cada um.

## Headers de saída (cliente → servidor)

Confiança: **✓** confirmado pelo conteúdo do corpo · **~** consistente com a tabela padrão do Nitro, não verificado no corpo · **?** função desconhecida.

| Header | Corpo observado | Leitura | Conf. |
|-------:|-----------------|---------|:-----:|
| 4096 | `string release`, `string "HTML5"`, ints | Hello / versão do cliente (`PRODUCTION-202101271337-HTML5`) | ✓ |
| 2490 | `string machineId` | Identificador único da máquina (`TEST4-IID-...`) | ✓ |
| 2419 | `string ssoTicket`, `string ...` | Ticket de autenticação (SSO). **Sensível.** | ✓ |
| 2596 | vazio | Pong do cliente (resposta ao 3928) | ✓ |
| 357, 219, 2781, 273, 3333, 813, 796, 2487, 487, 869, 1827, 2110, 3027, 1782, 2448, 3898 | vazio | Rajada pós-login: info do usuário, moedas, assinatura, amigos, badges, configurações… | ~ |
| 249 | `string código` (`hotel_view`, `official_view`) | Busca do navegador de quartos | ✓ |
| **2312** | `int32 roomId`, `string senha` | **Entrar em quarto.** Observado `7078217` e `7072685` (senha vazia) | ✓ |
| 2230 | `int32 roomId`, `int32 enterRoom`, `int32 forward` | Dados do quarto (GetGuestRoom). O cliente manda `(roomId, 1, 0)` logo após entrar (resposta ao 749) e `(roomId, 0, 1)` para **visitar**: o servidor responde 687 e o próprio cliente cria a sessão e manda o 2312. É como o app entra em quartos com a interface acompanhando, inclusive a partir da visão do hotel (o 2312 cru a partir da visão do hotel traz a sala inteira pelo protocolo, mas o Nitro fica sem sessão e a tela não muda) | ✓ |
| 21, 351, 2300 | vazio | Sequência de entrada na sala (modelo, heightmap, dados de entrada) | ~ |
| **3157** | `string nome` | **Pedido de amizade.** É tudo que o botão "Pedir Amizade" faz. Ex.: `00 05 "Wzzer"` | ✓ |
| **137** | `int32 count`, `int32 userId`… | **Aceitar pedido(s) de amizade.** Observado `[1, 5904602]` dez segundos após o 2219 de `kehlaree` (id 5904602) | ✓ |
| 3301 | `int32 x`, `int32 y` | Olhar para a posição (clique num avatar) | ✓ |
| 431 | `int32 roomIndex` | Pedir tags do usuário pelo índice na sala (ex.: 3121) | ✓ |
| 2091 | `int32 userId` | Pedir emblemas selecionados (ex.: 3528391) | ✓ |
| 2138 | `int32 userId` | Pedir status de relacionamento (mesmo id) | ✓ |
| 3878 | `string nome` | Pedir perfil pelo nome (visto uma vez, ao abrir perfil) | ~ |
| **3320** | `int32 x`, `int32 y` | **Andar até a posição.** Logo depois o 1640 mostra `/mv` rumo ao alvo (antes rotulado como "periódico") | ✓ |
| **3997** | `int32 userId` | **Seguir amigo.** Servidor responde 160 com o quarto dele | ✓ |
| **998** | `int32 groupId` | **Entrar no grupo** (GroupJoin). Grupo fechado vira pedido ao dono; recusa chega no 762 | não confirmado |
| **3582** | `int32 nota` | **Dar nota ao quarto** (RateFlat; o cliente manda 1) | não confirmado |
| **2730** | `string gênero`, `string visual` | **Trocar o próprio visual** (UserFigure). Servidor confirma com 2429. Confirmado 18/09/2026 | ✓ |
| **2249** | `string nick` | **Perfil pelo nick** (GetExtendedProfileByName). Resposta 3898 traz o visual mesmo offline; é o caminho do "copiar visual". Confirmado 18/09/2026 | ✓ |
| **1276** | `int32 count`, `int32 userId`…, `string mensagem` | **Convidar amigos para o quarto** (SendRoomInvite): o "selecionar todos e convidar" do console | não confirmado |
| **2694** | `int32 userId` | **Respeitar usuário** (RespectUser). Servidor responde 2815 a todos na sala; cota diária por conta. Confirmado 17/09/2026 com 8 contas (total do alvo subiu de 8 em 8: 511 → 519 → 527) | ✓ |
| 2991 | `int32 roomId`, `byte` | Pedir info do quarto (resposta 1702 com nome/descrição/tags) | ~ |
| **1314** | `string texto`, `int32 estilo` | **Falar na sala.** 21 B para "oi sem sussurro": sem o `trackingId` do Nitro padrão | ✓ |
| **1543** | `string "nome texto"`, `int32 estilo` | **Sussurrar.** O destinatário vai dentro da string, separado por espaço | ✓ |
| 1597 / 1474 | vazio | Comecei / parei de digitar (o 1474 sai junto com a mensagem) | ✓ |
| **3567** | `int32 userId`, `string texto` | **Mensagem no console** (messenger) para um amigo | ✓ |
| **3559** | vazio | **Pedir a casa da porta** (GetRoomEntryTile). Resposta 1664. O comando `:floor` do cliente manda este e o 1687 | ✓ |
| **1687** | vazio | **Pedir as casas ocupadas por mobi** (GetOccupiedTiles). Resposta 3990 | ✓ |
| 355, 3320, 1419 | pequenos | Periódicos / latência | ? |

## Headers de entrada (servidor → cliente)

| Header | Corpo observado | Leitura | Conf. |
|-------:|-----------------|---------|:-----:|
| 3928 | vazio | Ping do servidor (cliente responde 2596) | ✓ |
| **374** | `int32 count`, depois por usuário: `int32 id`, `string nome`, `string missão`, `string figura`, `int32 roomIndex`, `int32 x`, `int32 y`, `string z`, `int32 dir`, `int32 tipo`, e para tipo 1: `string sexo`, … | **Usuários na sala** (entrada e lista inicial). Fonte para substituir o `:chooser`. | ✓ |
| **1640** | `int32 count`, por unidade: `int32 roomIndex`, `int32 x`, `int32 y`, `string z`, `int32 headDir`, `int32 bodyDir`, `string status` (`/flatctrl 0/mv 31,31,0.0//`, `/sit …`) | Status e movimento dos avatares | ✓ |
| 2661 | `string roomIndex` | Usuário saiu da sala (RoomUnitRemove) | ✓ |
| 1717 | `int32 roomIndex`, `int32 digitando` | Digitando / parou de digitar | ✓ |
| 1167 | `int32 roomIndex`, `int32 efeito`, `int32 delay` | Efeito do avatar (12 B fixos) | ✓ |
| 1797 | `int32 roomIndex`, `bool` | Ocioso (idle) | ✓ |
| 1631 | 8 B | Expressão (acenar, rir…) | ~ |
| 2233 | 8 B | Dança | ~ |
| 1474 | 8 B | Item na mão | ~ |
| **1446** | `int32 roomIndex`, `string texto`, `int32 gesto`, `int32 estilo`, … | **Chat da sala** (fala normal). Mensagens do sistema também chegam aqui (roomIndex 3151 = bot/sistema) | ✓ |
| **2704** | mesma estrutura do 1446 | **Sussurro** recebido, incluindo o eco do seu próprio sussurro | ✓ |
| **1587** | `int32 senderId`, `string texto`, `int32 segundosDesdeEnvio` | **Mensagem do console** recebida | ✓ |
| 3920 | dados de usuário com figura, missão, sexo | Usuário mudou visual / info (RoomUnitInfo) | ✓ |
| 2182 | `int32 userId`, `int32 roomIndex`, `string html` | **Custom do Habblet:** nome colorido / tag (`<font color="#E10230">• Nome</font>`) | ✓ |
| **1087** | `int32 userId`, lista de emblemas | Emblemas do usuário (resposta ao 2091) | ✓ |
| **2016** | `int32 userId`, `int32 count`, por relação: `int32 tipo`, `int32 qtd`, `int32 amigoId`, `string nome`, `string figura` | Relacionamentos (resposta ao 2138) | ✓ |
| **2219** | `int32 userId`, `string nome`, `string figura` | **Pedido de amizade recebido** (alguém pediu para você). Ex.: `kehlaree`, id 5904602 | ✓ |
| **2800** | `int32 nCategorias`, …, `int32 nUpdates`, por amigo: `int32 tipo`, `int32 id`, `string nome`, `int32 sexo`, `bool online`, `bool naSala`, `string figura`, `int32 categoria`, `string missão`, … | **Atualização da lista de amigos.** Chega quando um amigo muda de sala, fica online/offline, muda missão ou status (`busy`) **e quando um pedido seu é aceito** (o alvo passa a aparecer aqui). Neste hotel o campo `tipo` veio `0` tanto para novo amigo quanto para atualização, então "novo" precisa ser detectado por id ainda desconhecido | ✓ |
| 3130 | lista de amigos com id, nome, figura… | Lista de amigos completa (pós-login) | ✓ |
| 2725 | `int32 id`, `string nome`, `string figura`, `string sexo`, … | Dados do próprio usuário (pós-login). Fonte do próprio id/nome | ✓ |
| 1036 | `int32 roomIndex`, `string texto`, … | Grito na sala (shout) | ✓ |
| 286 | `string título`, `string texto HTML`, `string botão` | **Diálogo/notificação do servidor** (ex.: "Loja Habblet"). Forte candidato ao alerta "não aceita pedidos de amizade" | ✓ |
| 432 | pares `string comando`, `string descrição` (`:sit`, `:empty`…) | **Custom do Habblet:** lista de comandos de chat disponíveis para a conta | ✓ |
| 2586 | `SAFE_CHAT`, `CITIZEN`, `FULL_CHAT` | Permissões de chat | ✓ |
| 758 | vazio | Quarto pronto / pode entrar (primeiro pacote após 2312) | ✓ |
| **3898** | `int32 id`, `string nome`, `string visual`, `string missão`, `string criação`, `int32 pontos`, `int32 amigos`, `bool amigo`, `bool pedidoEnviado`, `bool online`, grupos… | **Perfil de usuário** (UserProfile). Confirmado 18/09/2026 | ✓ |
| **2429** | `string visual`, `string gênero` | **Visual trocado** (FigureUpdate): confirmação do 2730. Confirmado 18/09/2026 | ✓ |
| **762** | `int32 motivo` | **Entrada no grupo recusada** | não confirmado |
| **2815** | `int32 userId`, `int32 respeitos` | **Alguém foi respeitado** (RespectReceived): chega para todos na sala com o total atualizado, dispara a animação. Confirmado 17/09/2026 | ✓ |
| **160** | `int32 roomId` | **Encaminhar para quarto** (resposta ao 3997). O cliente Nitro reage sozinho: 2230 → 687 → 2312 (só se o quarto for aberto; com campainha ele mostra o diálogo e não entra) | ✓ |
| 339 | vazio | Você é o dono do quarto (recebido ao entrar no próprio quarto) | ✓ |
| 1702 | `int32 roomId`, …, `string nome`, `string descrição`, tags… | Info/configurações do quarto (resposta ao 2991) | ~ |
| 780 | `int32` (0) | Após o 374 de entrada; provável nível de direitos / flag do quarto | ? |
| **122** | vazio | **Saiu do quarto para a visão do hotel.** Numa expulsão: `1600` (4008) → `2661` do próprio avatar → `122` → cliente manda `1827`. Numa entrada recusada: `2661` próprio → `899` → `122`, sem `758`. Na troca de quarto normal vem só o `2661` próprio seguido do `758` do novo quarto | ✓ |
| **1600** | `int32 código` | **Erro genérico.** `4008` = você foi expulso do quarto. Observado 15 vezes em 14/09/2026, sempre imediatamente antes do `2661` próprio e do `122` | ✓ |
| **899** | `int32 motivo`, `string parâmetro` | **Entrada no quarto recusada** (RoomEnterError): `1` = quarto cheio, `4` = banido do quarto. O 2312 pendente morre aqui: não vem `758` | ✓ |
| **1778** | `int32 nDonos` (id, nome)…, `int32 n`, mobis (ver "Mobis de chão") | **Mobis de chão do quarto** (ObjectsMessage). Decodificado: 2.757 pacotes reais, 1,5 milhão de mobis, 0 erros (20/09/2026) | ✓ |
| **1534** | um mobi + `string donoNome` | **Mobi de chão colocado/apareceu** (ObjectAdd) | ✓ |
| **2703** | `string id`, `bool expirou`, `int32 quemPegou`, `int32 atraso` | **Mobi de chão removido** (ObjectRemove) | ✓ |
| **3776** | um mobi | **Mobi de chão movido/girado/atualizado** (ObjectUpdate) | ✓ |
| **1369** | `int32 nDonos` (id, nome)…, `int32 n`, por mobi: `string id`, `int32 spriteId`, `string posição` (`:w=x,y l=x,y l` ou `r`), `string estado`, `int32 expira`, `int32 uso`, `int32 donoId` | **Mobis de parede** (ItemsMessage). 1.933 pacotes, 37 mil mobis, 0 erros (21/09/2026) | ✓ |
| 687 | `string nome`, `string descrição`, thumbnail… | Dados do quarto (resposta ao 2230) | ✓ |
| 3052, 3984, 1562, 3244 | textos do navegador | Metadados do navegador: abas, salas em destaque, categorias, promovidas | ✓ |
| 806, 717, 305, 2493, 3625 | `ACH_…` | Conquistas (lista, progresso, notificações) | ✓ |
| 325 | `sexual_content`… | Categorias de denúncia | ✓ |
| 222 | `basejump`, URL | Game center | ✓ |
| 2107 | `int32`, `int32`, `int32`, `string ACH_…`, `string categoria` | Conquista progrediu | ✓ |
| 2454 | `string floor/wallpaper/landscape`, `string valor` | Pintura do quarto | ✓ |
| 2031 | `string modelo` (`dynamic_heightmap`) | Nome do modelo do quarto | ✓ |
| 2690 | resultados com nomes de quarto | Resultado da busca do navegador | ✓ |
| 1112 | IDs do YouTube, nomes de rádio | **Custom do Habblet:** rádio / player | ✓ |
| 1453 | `int32 count`, itens com id e string numérica | Muito frequente (mais de 700 em 6 min). Provavelmente atualização de dados de mobis (ObjectsDataUpdate) | ? |
| 416 | `int32 id`, `int32 20`, pares `string nome`/`string número` (`Perfeito`/`1693658`) | Muito frequente e sempre os mesmos nomes: parece um mobi de placar/ranking atualizando (`Perfeito`, `Maokai`). Não é chat | ? |
| 360 | `int32 n`, por item: `int32 roomIndex?`, `int32 x`, `int32 y`, `int32 x2`, `int32 y2`, `string z`, `string z2`, `int32 mobiId`, `int32 500`, `int32` | NÃO é o ObjectUpdate (esse é o 3776). Traz um id de mobi e destino (x2, y2): parece o deslize de esteiras/rolos (SlideObjectBundle); milhares por sessão em quartos com rolos | ? |
| 2547 | 18 B, ints constantes | Desconhecido, periódico | ? |
| **1301** | `bool`, `int32 alturaParede` (-1 = padrão), `string mapa`, `int32 n` áreas (`int32 mobiId`, `bool`, `int32 x`, `int32 y`, `int32 w`, `int32 h`) | **Planta do quarto** (FloorHeightMap): linhas separadas por `\r`, um caractere por casa: `x` = sem chão, `0`–`9`/`a`–`z` = altura do piso. A lista de áreas no fim é extensão do Habblet (n = 0 em 55% dos quartos; parece marcar retângulos de mobis especiais) e ainda não tem leitura confirmada | ✓ |
| **2753** | `int32 largura`, `int32 nCasas`, `int16` por casa | **Mapa de altura empilhada** (HeightMap): por casa, `(v & 0x3fff) / 256` = altura do topo (piso + mobis em cima), `0x3f3f` = sem chão, bit `0x4000` = não empilhável. É a altura que um avatar teria ao pisar ali | ✓ |
| **3990** | `int32 n`, por casa: `int32 x`, `int32 y` | **Casas ocupadas por mobi** (RoomOccupiedTiles), resposta ao 1687 | ✓ |
| **1664** | `int32 x`, `int32 y`, `int32 direção` | **Casa da porta** (RoomEntryTile), resposta ao 3559 | ✓ |
| 2402 | grande, na entrada do quarto | Mobis de parede / dados do quarto | ~ |

## Sequências observadas

### Clique num usuário pelo DOM (o que o Add User All faz hoje)

```
↑ 3301  olhar para (x, y) do avatar
↑ 431   tags do usuário           (roomIndex)
↑ 2091  emblemas selecionados     (userId)
↑ 2138  status de relacionamento  (userId)
↓ 1087  emblemas                  (userId, …)
↓ 2016  relacionamentos           (userId, …)
↑ 3157  pedido de amizade         (nome)          ← só quando clica em "Pedir Amizade"
```

Nada disso é necessário para pedir amizade. O pedido é um único pacote 3157 com o nome. O quarteto anterior é só o cliente montando o menu de contexto.

### Resposta ao pedido de amizade

Em 1,2 s após cada 3157 **não chega nenhum acknowledgment**: o servidor aceita o envio em silêncio. O que existe é o efeito posterior:

- **Quando o alvo aceita**, ele aparece num **2800** com id, nome, figura e missão. Na captura, vários alvos do Add User All apareceram em 2800 segundos depois do 3157 (`Nickyyyyyyyy` em 1 s, `Lolinha!!`, `LWolf`, `kalygata2`, `Rapper7Poeta`…). Aceites tão rápidos indicam que boa parte dessas contas roda auto-aceite.
- **Quem já é amigo** continua gerando 2800 a cada mudança de sala ou missão (ex.: `Cruzcruss` apareceu 8 vezes). Por isso o mapa `id → amigo` precisa existir antes para distinguir "novo amigo" de "atualização".
- **Pedido recusado por configuração** ("não aceita pedidos"): ainda não observado. O candidato é o **286** (diálogo com título, texto e botão), que já vimos ser usado para avisos do servidor.

### Pedido recebido e aceite (fluxo completo, observado)

```
17:25:30  ↓ 2219  pedido recebido      userId=5904602, nome="kehlaree", figura
17:25:40  ↑ 137   aceitar              [count=1, 5904602]           ← clique em aceitar
17:25:40  ↓ 2800  lista de amigos      kehlaree com figura e missão  ← virou amigo
17:27:55  ↓ 2800  kehlaree             atualização (missão "aylo.me/kehlaree")
```

Isso fecha o ciclo de amizade pelo protocolo: **3157 pede, 2219 avisa que pediram, 137 aceita, 2800 confirma.**

### Conexão e login (ordem exata, captura de 17/09/2026)

```
↑ 4096  release "PRODUCTION-202101271337-HTML5", "HTML5", ints
↑ 2490  machine id                                ← sensível
↑ 2419  SSO ticket                                ← sensível
↓ 2491  vazio: ticket aceito (AuthenticationOK)
↓ 1488  eco do machine id · 411 · 151 · 2033 · 1255 · 3928 ping · 513 · 432 comandos · 2875 (home room) · 3151 · 340 · 222 · 2893 · 325
↑ 2596  pong
↑ 2312  quarto inicial (o cliente entra sozinho no "home room" do 2875)
↑ 357 · 219 · 2781 · 273 · 3333 · 813 · 796 · 2487 · 487 · 869 · 1827   (rajada, todos vazios)
↓ 2018 · 3475 · 2725 (eu: id, nome, figura)
↑ 3878 (meu nome) · 3027 · 1782 · 2448                                (vazios, exceto o 3878)
↓ 2727 · 1452 · 2586 permissões de chat · 1968 · 1605 · 717 · 2501 · 305 · 3130 lista de amigos · 280 · 3625 · 2238 · 286 · 758 (quarto pronto)…
↑ 249   busca official_view / hotel_view  →  ↓ 2690 (resultados), 3052, 3984, 1562, 3244
```

O servidor manda um **3928 a cada 30 s** e o cliente responde 2596 na hora. O WebSocket (`wss://game.habblet.city`, sem path) é servido por **nginx, sem Cloudflare**, e aceita um cliente fora do navegador (Node + `ws` com `Origin: https://www.habblet.city`) com HTTP 101 em menos de 1 s (testado em 17/09/2026).

### Cliente sem tela (o que o app emula)

No modo sem tela da Multidão o agente devolve ao Nitro um socket falso, captura o 4096/2490/2419 e o processo principal abre a conexão de verdade e os reenvia iguais. Daí em diante `electron/headless-protocol.ts` reproduz o que o cliente faria sozinho:

| Recebe | Cliente responde |
|-------:|------------------|
| 3928 | 2596 |
| 2491 | 357, 219, 2781, 273, 3333, 813, 796, 2487, 487, 869, 1827 (vazios) |
| 2725 | 3027, 1782, 2448 (vazios) |
| 758 | 21, 2300 (vazios) |
| primeiro 374 após o 758 | 351 (vazio) e 2230 `(roomId, 1, 0)` |
| 160 | 2312 `(roomId, "")` direto (no Nitro seria 2230 `(roomId, 0, 1)` → 687 → 2312) |

O 2312 do "home room" não é reproduzido: quem decide em que quarto entrar é o dashboard. O que **ainda não foi validado ao vivo**: se o servidor aceita o ticket vindo do cliente headless (a interceptação garante que o Nitro não o consumiu antes) e se exige algo mais da rajada.

### Entrar / trocar de quarto (observado 3 vezes: 7078217 → 7072685 → 7078217; ordem exata confirmada em 16/09/2026)

```
↑ 2312  entrar            (roomId, senha "")
↓ 2661  eu saio do quarto anterior (se havia)
↓ 758   pronto
↓ 2031  modelo            ("dynamic_heightmap")
↑ 21, 2300                pedidos vazios (o cliente manda logo após o 758)
↓ 2454 pintura · 482 · 408 · 2753 heightmap · 1301 · 1840
↓ 374   usuários          (primeiro = eu)
↑ 351                     vazio
↑ 2230  dados do quarto   (roomId, 1, 0)
↓ 374 · 1640 · 1778 · 1369 · 687 …
```

Detalhe (visão antiga da mesma sequência):

```
↓ 2031  modelo            ("dynamic_heightmap")
↓ 2454  pintura           (floor / wallpaper / landscape)
↓ 482, 408               flags do quarto
↓ 2753  heightmap         (até 8 KB)
↓ 1301  mapa de altura relativo
↓ 1840
↓ 374   usuários          primeiro pacote = eu mesmo (count 1); os demais chegam em 374 separados, alguns enormes (30 KB)
↓ 1778  mobis de chão     (32 KB)
↓ 1369  mobis de parede
↓ 687   dados do quarto   (nome, descrição, thumbnail)
↓ 1640  status dos avatares (6 KB na entrada)
↓ 2661  saídas · 1446 chat · 1717 digitando · 1167 efeito · 2402 · 1112 rádio …
```

Sair do quarto A e entrar no B é só um novo 2312; o servidor reenvia a sequência inteira. Não há pacote de "sair".

### Seguir um amigo até o quarto dele (observado 2 vezes)

```
↑ 3997  seguir              (userId 5908929)
↓ 160   encaminhar          (roomId 7092591)
↑ 2230  dados do quarto     (roomId, 0, 1)        ← o cliente faz sozinho (enterRoom 0, forward 1)
↓ 687   dados               ("Eu e ela", dono BAROxZ, doorMode 1 = campainha)  → não entra, mostra a campainha
```
```
↑ 3997  seguir              (userId 1407772)
↓ 160   encaminhar          (roomId 6539664)
↑ 2230 (roomId, 0, 1) → ↓ 687 ("LABIRINTO GALAXY", doorMode 0) → ↑ 2312 → ↓ 2661 (eu) → ↓ 758 → sequência de entrada
```

Para o app, "seguir" é só mandar o 3997: o cliente completa a entrada. Para forçar a entrada mesmo sem passar pelo cliente, dá para ler o roomId do 160 e mandar o 2312 direto.

### Entrar num quarto com a interface acompanhando (`visitRoom`)

O mesmo caminho do 160 serve para o app entrar num quarto qualquer: mandar `2230 (roomId, 0, 1)`. O servidor responde `687` e o cliente Nitro cria a sessão de quarto e envia o `2312` sozinho (~250 ms depois), então a tela muda junto. O `2312` cru funciona quando já se está num quarto (o cliente reaproveita a sessão), mas a partir da visão do hotel (depois de expulsão ou entrada recusada) o servidor manda a sala inteira e a interface fica parada no hotel — o app passa a receber o 374 do quarto sem "estar" nele. O Auto Room usa o `visitRoom` e só cai para o `2312` cru se o cliente não mandar o dele em 2,5 s.

### Expulsão e entrada recusada (observado em 14/09/2026, 15 expulsões e 2 recusas)

```
↓ 1600  erro genérico 4008 (expulso)
↓ 2661  eu saio
↓ 122   visão do hotel
↑ 1827                                  ← o cliente
↓ 286   aviso "Loja Habblet" (o diálogo da recepção, não é erro)
```
```
↑ 2312  entrar (quarto B)
↓ 2661  eu saio do quarto A
↓ 899   motivo 1 (cheio) ou 4 (banido), parâmetro ""
↓ 122   visão do hotel — não vem 758
```


### Movimento e status dos avatares (gramática do 1640)

Cada unidade no 1640 traz `roomIndex, x, y, z, headDir, bodyDir` e a string `actions`, uma sequência de `/chave args` terminada em `//`:

| Trecho | Significado |
|--------|-------------|
| `/flatctrl 0` · `/flatctrl 1` · `/flatctrl 4` | direitos no quarto: nenhum, direitos, **dono** |
| `/mv 7,10,0.0` | **andando**: alvo do próximo passo (x, y, z). O servidor manda um 1640 por passo, ~2 por segundo, e um sem `/mv` ao parar |
| `/sit 0.5` · `/lay 0.5` | sentado / deitado (altura) |
| outros (`wav`, `dance`, `sign N`…) | gestos e ações |

O app já usa isso: a aba Jogo mostra `→(x,y)` enquanto o avatar anda, `sentado`/`deitado` e `dono`/`direitos`, e guarda `lastMoveAt` por usuário. Andar é o 3320 com (x, y); o botão **ir até** na lista da sala anda até a posição de alguém.

### Mobis de chão (1778, 1534, 3776) e o furnidata

Cada mobi segue o `FurnitureFloorDataParser` do Nitro, com um detalhe do Habblet no placar:

```
int32 id · int32 spriteId (= id no furnidata) · int32 x · int32 y · int32 direção (0/2/4/6)
string z · string altura (stackHeight) · int32 extra
int32 tipoDados            → kind = tipo & 0xFF · flags = tipo >> 8 (0x1 = edição limitada)
  kind 0  string estado                      (98,6% dos mobis)
  kind 1  int32 n, pares string chave/valor  (mapa: MESSAGE, PURCHASER_NAME…)
  kind 2  int32 n, strings                   (ex.: troféu: "0", "HBT1398", "Lay30", "22-1-2025")
  kind 3  string estado, int32 resultado     (voto)
  kind 4  vazio
  kind 5  int32 n, int32…                    (números)
  kind 6  string estado, string título, int32, string coluna1, string coluna2,
          int32 scoreType, int32 clearType, int32 n, por linha: int32, int32 pontos, int32 nUsuários, strings
          ← VARIANTE DO HABBLET: o Nitro padrão não tem título nem colunas; com a estrutura padrão o
            leitor desalinhava e perdia o resto do pacote (17% dos 1778 falhavam)
  kind 7  string estado, int32 hits, int32 target (quebrável)
  flags & 0x1 → int32 número, int32 série
int32 expira · int32 política de uso · int32 donoId · [string classe, se spriteId < 0]
```

O 1778 vem em geral num pacote só (1 por entrada em 96% das vezes), mas quartos grandes chegam em vários; o GameState acumula por id e zera no 758. Direção 2 ou 6 = mobi girado (largura e profundidade trocam). Na pilha, o mobi de maior `z` é o que está "em cima" da casa.

**Furnidata.** Que mobi é sentável/deitável vem do furnidata do hotel, não do protocolo: `https://images.habblet.city/habblet-asset-bundles/gamedata/habblet_furni.json` (URL no `renderer-config.json` em `https://images.habblet.city/habblet-asset-bundles/config/`, descoberta pelo cache do webview em 20/09/2026; 17 MB, 37.017 mobis de chão, 2.587 `cansiton`, 343 `canlayon`, com `xdim`/`ydim`). O app baixa uma vez, reduz aos ~2.900 sentáveis/deitáveis (`shared/furnidata.ts`) e guarda em `%APPDATA%\habblet-addall\furnidata.json` (renova a cada 7 dias).

**Sentar pelo protocolo é só andar.** Não há pacote "sentar": o cliente manda `3320 (x, y)` da casa do mobi e o servidor devolve o 1640 do avatar com `/sit 1.0//` (a altura é a do assento; deitar = `/lay 0.5//`). Confirmado em capturas: 1.243 status `/flatctrl N/sit N//`, 351 `/sit N//`, 15 `/lay N//`. Levantar = andar para uma casa vizinha. É o que o comando "Todas sentadas" da Multidão faz (`src/addons/protocol/postureEngine.ts`).

### O comando `:floor` (editor de planta) — observado em 21/09/2026 com a conta Dominguez

`:floor` não vai para o servidor: é um comando **do cliente Nitro** que abre o editor de planta do quarto. Nada de 1314; o cliente manda `1474` (parou de digitar) e dois pedidos vazios, e o servidor responde na hora:

```
↑ 1474  parei de digitar
↑ 3559  GetRoomEntryTile
↑ 1687  GetOccupiedTiles
↓ 3990  casas ocupadas por mobi: count 78, pares (x, y)          628 B = 4 + 78 × 8
↓ 1664  casa da porta: x 4, y 7, direção 2                        12 B
```

O editor também usa o que já chega em toda entrada de quarto: **1301** (planta, `x` = sem chão) e **2753** (altura do topo de cada casa, com os mobis). No quarto observado (12 × 16): a planta mostra o corredor da porta em (4, 7), e o mapa de altura mostra 1.0 onde há cadeiras/mesas, 2.3 e 3.3 onde há pilhas, 0.0 no chão livre — casas ocupadas no 3990 batem com as alturas > 0 do 2753. Para o app isso significa que dá para saber, **antes de andar**, o que é chão, o que tem mobi e a que altura; hoje o "ir até"/"sentar" descobre isso tentando casa a casa.

### Terceiros na sala

Em 6 minutos: 32 pacotes 374 (chegadas e listas), 36 pacotes 2661 (saídas), 87 falas em 1446 (duas do sistema, índice 3151/3160), 1 grito em 1036, 491 eventos de digitação, 560 de movimento. Tudo carrega o `roomIndex`, que o 374 associa a id e nome. Com isso o app consegue manter, sem tela, quem está na sala, onde está, o que falou e quando saiu.

## Tamanho dos pacotes

O agente guarda até **4 MB** de corpo por pacote (antes eram 256 KB). O limite antigo foi derrubado em 17/09/2026 por uma conta com **5.929 amigos**: o 3130 dela tem 337 KB, chegava cortado, o decodificador estourava e a lista de amigos ficava vazia (o Add User All perdia o filtro de "já é amigo" e o aceite de pedidos nunca era detectado). Hoje, além do limite maior, o `parseFriendsFragment` fica com os amigos que couberam quando o corpo vem truncado e o GameState registra o corte como `decode-error` em vez de perder tudo. Os maiores pacotes vistos: 3130 (337 KB), 1778 mobis de chão (32 KB+), 374 com muitos usuários (30 KB), 2753 heightmap (8 KB).

### Construção, catálogo e inventário — sessão de marcadores de 21/09/2026 (quarto da conta Dominguez)

Tudo abaixo foi observado ao vivo, com o app acompanhando a captura em tempo real. Os headers batem com a tabela padrão do Nitro.

| Ação | Cliente manda | Servidor responde |
|------|---------------|-------------------|
| Salvar planta no editor (`:floor`) — o Colar quarto salva duas vezes: a planta de obra antes dos mobis e a real no fim. Regra dos modos de construção (usuário, 21/09/2026): `:up`/`:spin` valem no mover (248); `:state` só vale na colocação (1258) | **875** `string planta` (linhas por `\r`), `int32 portaX`, `portaY`, `portaDireção`, `espessuraParede`, `espessuraPiso`, `alturaParede` (-1) | **3801** aviso "Seu quarto foi modificado com sucesso com o Editor de Chão! Reentre…", depois **160** (encaminhar) → cliente manda 2312 e recebe a sala inteira de novo |
| Colocar mobi de chão | **1258** `string "id x y direção"` | **159** (id saiu do inventário), **1534** (mobi no quarto) |
| Colocar mobi de parede | **1258** `string "id :w=x,y l=x,y l "` (posição do cliente + espaço) | 159, **2187** |
| Mover / girar mobi de chão | **248** `int32 id`, `x`, `y`, `direção` | **3776** |
| Usar mobi de chão (avançar estado) | **99** `int32 id`, `int32 0` | **2547** `string id`, dados do mobi (estado novo) |
| Pegar mobi de chão | **3456** `int32 10`, `int32 id` | **2703** (alguns segundos depois) |
| Mover mobi de parede | **168** `int32 id`, `string posição` | **2009** |
| Usar mobi de parede | **210** `int32 id`, `int32 0` | **2009** com o estado novo |
| Aplicar piso / papel / paisagem | **711** `int32 idDoItem` (item de piso/papel do inventário) | **2454** `string tipo`, `string valor` |
| Pedir inventário | **3150** vazio | **994** em fragmentos: `int32 total`, `int32 índice`, `int32 n`, por item: `int32 id`, `string tipo` (S chão / I parede), `int32 ref`, `int32 spriteId`, `int32 categoria`, dados do mobi, 4 bools, `int32 expira`, `bool`, `int32 quarto` [, `string`, `int32` se S] |
| Pedir índice do catálogo | **1195** `string "NORMAL"` | **1032** árvore: por nó `bool visível`, `int32 ícone`, `int32 páginaId`, `string nome`, `string localização`, `int32 n` ofertas (ids), `int32 n` filhos… (1.035 páginas, 28 mil ofertas) |
| Pedir página do catálogo | **412** `int32 páginaId`, `int32 -1`, `string "NORMAL"` | **804** `int32 páginaId`, `string tipo`, `string layout`, imagens, textos, `int32 n` ofertas: `int32 ofertaId`, `string nome`, `bool aluguel`, `int32 créditos`, `int32 pontos`, `int32 tipoPontos`, `bool presenteável`, produtos (`string tipo` s/i/e/b, `int32 spriteId`, `string extra`, `int32 qtd`, `bool limitado`…), `int32 clube`, `bool pacote`, `bool pet`, `string prévia` |
| Comprar | **3492** `int32 páginaId`, `int32 ofertaId`, `string extra` (o `extra` do produto, ex.: "0"), `int32 quantidade` | **869** compra aceita (`int32 ofertaId`, `string nome`…), **2103** itens novos (`int32 nCategorias`, por categoria `int32 cat`, `int32 n`, ids), **1992** notificação com ícone. Uma oferta pode entregar vários mobis (pacotes) |

**Altura e estado exatos, pelos comandos do servidor.** `:up N` liga um modo de construção: enquanto ligado, todo **248** (mover) põe o mobi na altura absoluta N (observado: `:up 2` → três mobis movidos em seguida ficaram em z = 2.0; `:up 5` → 5.0). `:up` sem número desliga. `:state N` funciona igual para o estado (`:state 1` + mover → estado 1 num mobi colocado com 0); num mobi de dois estados `:state 2` não fez nada. `:spin` não foi testado. É assim que o "Colar quarto" reproduz pilhas e estados (`src/protocol/roomPaste.ts`).

Também confirmados de passagem: **3870** convite de quarto de amigo (`int32 userId`, `string texto`), **1990** jogar dado (`int32 id`), **2281** gravar texto num mobi (id, ints, `string texto`), **2343** `int32 1`, `int32 1`, `int32 id` e **711** ao selecionar itens no inventário.

## O que ainda não foi observado

Precisa de uma sessão com marcadores (aba Protocolo → campo "Marcador" → Marcar → ação):

1. Pedido para quem **não aceita** pedidos: pacote de erro.
2. Pedido para quem **já é amigo**.
3. **Grito** de saída (Nitro padrão: 2085), ainda não visto.
4. **Cutucar** (Nudge). Pelo DOM é só o clique no avatar, então o equivalente seria 3301 + 431/2091/2138. A mensagem "X clicou em você!" chegou em 1446 como texto do sistema, o que sugere que o servidor detecta o 431/2091/2138 e avisa o alvo. A confirmar com marcador. O app já tem o motor por protocolo do Nudge Everyone (`NudgeEngine`, opcional nas configurações) reproduzindo exatamente esse quarteto por usuário; o teste é ligar em uma conta e ver se outra recebe o aviso.

Já cobertos: aceitar pedido (137), troca de quarto (2312 + sequência), pedidos recebidos (2219), aceites dos seus pedidos (2800), chat e grito de terceiros (1446, 1036), entradas e saídas (374, 2661), **falar (1314), sussurrar (1543 → 2704), digitar (1597/1474) e console (3567 → 1587)**, estes últimos numa sessão com ações manuais em 13/09/2026 às 18:36.

## Segurança dos arquivos de captura

O corpo do pacote **2419 contém o ticket SSO** da sua sessão e o **2490 o identificador da máquina**. A partir da próxima versão o agente grava esses dois com o corpo mascarado. Arquivos gerados antes disso (como o desta sessão) não devem ser compartilhados.

Os arquivos ficam em `%APPDATA%\habblet-addall\captures\` e não fazem parte do repositório.

## Ferramentas

- `tools/protocol/analyze_capture.py [arquivo.ndjson] [--header N] [--hex] [--around S]` — tabela de headers, exemplos por header e linha do tempo ao redor de marcadores.
- `tools/protocol/live_digest.py [janela_s]` — acompanha o arquivo da sessão atual e imprime resumos por janela, marcadores, eventos de socket e sondagem.
- `shared/known-headers.ts` — rótulos padrão que a aba Protocolo mostra quando você ainda não rotulou um header.

## Onde isso vive no código

- `src/protocol/nitro/headers.ts` — números de header (OUT/IN) com a estrutura de cada um no comentário.
- `src/protocol/nitro/parsers.ts` / `composers.ts` — decodificadores e compositores tipados; `src/protocol/decode.ts` tem o `PacketReader`/`PacketWriter`.
- `src/protocol/state/GameState.ts` — eu, amigos, pedidos, sala (por `roomIndex`), navegador, eventos; alimentado só pelos pacotes.
- `src/protocol/actions.ts` — ações (pedir amizade, aceitar, entrar/visitar quarto, falar, sussurrar, console, andar, seguir, clicar).
- `src/addons/protocol/engines.ts` — os motores dos addons em cima do GameState + ações.
- `tests/` — pacotes sintéticos com estas estruturas e testes dos fluxos acima; `npm run proto:replay` reproduz uma captura real.

## Próximos passos da camada de protocolo

1. Validar ao vivo o cliente sem tela (modo padrão da Multidão): ticket aceito pelo servidor, quarto entra pelo 2312 direto, motores funcionam sem página.
2. Sessão de marcadores cobrindo a lista acima (recusa de pedido, pedido a amigo, grito, efeito do Nudge por protocolo).
3. Decodificar o que ainda está marcado com `?` (1453, 416, 360, 2547, 780) conforme aparecer necessidade. O 360 já tem a cara de deslize por rolos (id do mobi + destino).
4. Mobis de parede (1369) e heightmap (2753): com o mapa de altura decodificado, o "ir até"/"sentar" saberia de antemão o que é chão e não precisaria tentar casa a casa.
