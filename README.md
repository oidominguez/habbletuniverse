# Habblet AddAll

Aplicativo desktop (Electron + React) com navegador embutido que injeta scripts de automação no cliente web do Habblet (cliente Nitro). Os scripts são organizados em **addons** que podem ser ativados e configurados individualmente pela interface.

## Addons

| Addon | Script | O que faz |
|-------|--------|-----------|
| **Add User All** | `public/scripts/addall-injectable.js` | Abre a lista de usuários da sala (`:chooser`), envia pedido de amizade para cada um, com fila, retentativas e detecção de "não aceita solicitações". Inclui **Auto Room** (visita quartos quando a fila esvazia). |
| **Auto Message** | `public/scripts/addall-commandsloop-injectable.js` | Envia comandos ou frases no chat em intervalo configurável. |
| **Automatically Reply to Whispers** | `public/scripts/addall-autoreply-whispers-injectable.js` | Responde sussurros recebidos com `Sussurrar <nick> <mensagem>`, alternando um prefixo. |
| **Nudge Everyone** | `public/scripts/nudge-everyone-injectable.js` | Clica em cada pessoa da lista, uma a uma, em ciclos. Motor por protocolo **experimental** (reproduz o clique pelos pacotes 3301+431+2091+2138) disponível nas configurações; padrão continua DOM até o efeito ser confirmado ao vivo. |
| **Console Tracker** | `public/scripts/console-tracker-injectable.js` | Detecta mensagens novas no console, responde automaticamente e limpa os chats. |
| **Auto Aceitar** | só protocolo | Aceita pedidos de amizade recebidos (2219 → 137) com atraso e lista de ignorados. |

**Auto Room (protocolo).** Dentro do Add User All: sem ninguém novo para adicionar por X segundos, busca quartos no navegador (249), entra no mais cheio ainda não visitado (2312) e adiciona todo mundo; ao esgotar a lista, recomeça. Configurável: tempo ocioso, mínimo de usuários e código da busca.

**Motores.** Add User All, Auto Message, Automatically Reply to Whispers e Console Tracker rodam por padrão pelo **protocolo** (pacotes do jogo, sem tocar na interface). Cada um tem uma seção "Motor" nas configurações para voltar ao script DOM antigo. Nudge Everyone é o inverso: DOM por padrão, protocolo opcional (experimental). Código dos motores: `src/addons/protocol/engines.ts` (classes puras, uma instância por sessão de jogo, testadas em `tests/engines.test.ts`).

## Requisitos

- Node.js 20 ou superior
- Windows (o build de distribuição gera NSIS e portátil x64)

## Como rodar

### Desenvolvimento

```bash
npm install
npm run dev
```

Inicia o Vite e o Electron juntos. A janela abre com a interface; use a barra de URL (ou os atalhos) para abrir o hotel, faça login e ative os addons.

Se a janela não abrir, rode `npm run build:electron` para ver erros de TypeScript do processo principal. Alternativa em dois terminais: `npm run vite:dev` e, quando o Vite estiver em http://localhost:5173, `npm run dev:electron-wait`.

### Produção

```bash
npm run build      # Vite + tsc do Electron
npm run start      # build + abre o Electron
npm run pack       # pasta descompactada em release/win-unpacked
npm run dist       # instalador NSIS + executável portátil em release/
```

### Qual build está rodando (não misturar versões)

`release/win-unpacked/Habblet AddAll.exe` **não se atualiza sozinho**: ele é uma fotografia do código no momento em que `npm run pack` rodou. Editar o código não muda o executável. Por isso cada compilação recebe uma marca, gerada por `tools/build-stamp.mjs` em `shared/build-info.ts` (arquivo gerado; não editar à mão) e mostrada em quatro lugares, sempre igual:

- **título da janela** — `Habblet AddAll · build 21/09 10:20`, visível na barra de tarefas sem precisar abrir o app;
- **pé do trilho esquerdo** — a hora do build, abaixo do indicador `live`/`off` (`dev` quando é desenvolvimento);
- **tela inicial** — "Build empacotado de 21/09 10:20";
- **log do dia** — primeira linha, em `%APPDATA%\habblet-addall\logs\`.

`build` significa compilado (o que está em `dist/` e no executável de `release/`); `dev` significa `npm run dev`, com recarga. **Se a marca do app não bater com a hora do seu último `npm run pack`, você está rodando um executável velho** — rode `npm run pack` de novo.

Fluxo recomendado: `npm run dev` enquanto desenvolve; `npm run pack` quando quiser usar o executável; e confira a marca antes de concluir que uma mudança "não funcionou".

**Feche o app antes de empacotar.** Com o "Habblet AddAll" aberto a partir de `release/win-unpacked`, o Windows trava o `.exe` e as DLLs; o electron-builder aborta ao limpar a pasta (`remove d3dcompiler_47.dll: Access is denied`) e **a pasta fica com o build anterior**. Aconteceu em 21/09/2026: o `dist/` foi regerado e o executável não, e o app testado era o de vinte minutos antes. Por isso `pack` e `dist` agora chamam `tools/verify-pack.mjs`:

- **antes** de compilar, ele falha em um segundo se a pasta estiver em uso, com a instrução de fechar o app (em vez de descobrir isso depois de dois minutos de build);
- **depois** de empacotar, ele abre o `app.asar` e exige encontrar lá dentro a marca deste build. É verificação por conteúdo, não por data: se o empacotamento não pegou, o script falha, mesmo que a saída do electron-builder tenha passado batida (um `| grep` na frente do comando já esconde o código de saída).

**Uma instância por pasta de dados.** O app usa `app.requestSingleInstanceLock()`: abrir o executável de `release/` com o `npm run dev` já aberto (ou dois executáveis de builds diferentes) traz a janela existente para a frente em vez de abrir outra. Sem isso, dois apps gravariam o mesmo `config.json` e `crowd.json` e o último a escrever apagaria as contas e configurações do outro. A trava é por `userData`, então a instância de teste com `HABBLET_USER_DATA` continua abrindo em paralelo normalmente.

### Qualidade

```bash
npm run lint       # ESLint (zero avisos é o padrão)
npm run typecheck  # tsc do renderer, do Electron e dos testes, sem emitir
npm test           # Vitest: decodificação, parsers, GameState e motores
npm run check      # os três acima, em sequência (o que o CI roda)
npm run format     # Prettier
npm run proto:replay [-- captura.ndjson] [--rooms]   # regressão contra uma captura real
```

**Testes.** Ficam em `tests/`, rodam no Node puro (sem Electron nem DOM) e usam pacotes sintéticos montados com o `PacketWriter` (`tests/helpers.ts`), com a mesma estrutura documentada em `docs/PROTOCOLO.md`: login, lista de amigos (inclusive truncada), entrada/saída/expulsão/recusa de quarto, chat, console e o comportamento de cada motor (Add User All com Auto Room, Auto Aceitar, sussurros, console, Auto Message, Nudge). O `proto:replay` complementa: reproduz uma captura NDJSON real no GameState e resume o que ele entendeu.

**CI.** `.github/workflows/ci.yml` roda lint, typecheck, testes e o build a cada push/PR (com `npm ci --ignore-scripts`, sem baixar o binário do Electron).

## Uso

1. **URL** — Digite a URL do cliente e clique em **Ir** (ou use um atalho).
2. **Login** — Faça login na página que abriu no navegador embutido.
3. **Addons** — Abra o painel **Addons**, ative os que precisar e ajuste as configurações de cada um. Os addons são reaplicados automaticamente quando a página termina de carregar.
4. **Estatísticas** — Na fila, Processando, Concluídos, Ignorados e Não aceita solicitações (sidebar esquerda).
5. **Painel inferior** — **Logs** (limpar, exportar `.txt`) e **Board da fila** (filtrar, exportar `.txt`). Redimensionável e recolhível.

## Multidão (várias contas)

A aba **Multidão** controla várias contas do Habblet ao mesmo tempo. Cadastre usuário e senha (a senha é criptografada pelo Windows via `safeStorage`/DPAPI e guardada em `crowd.json`, fora do perfil exportável). Cada conta conectada roda o cliente do jogo num `<webview>` com sessão isolada (`persist:crowd-<id>`): o app preenche o login no site (aguardando o Turnstile), abre `/hotel`, e a partir daí a conta tem o mesmo GameState, ações e motores por protocolo da janela principal.

**Comandos.** O painel tem um seletor de **alvo**: "Todas" ou qualquer combinação de contas (chips com o nick); os comandos agem nas contas alvo que estão online e não pausadas, e o toast diz em quantas agiu. Grupos:

- **Movimento**: **Ir até** um nick (anda até a casa livre ao lado dele, uma vez), **Fixar** (perseguição em tempo real: lê a posição e o destino do `/mv` dele no 1640, anda até a casa vizinha mais próxima pelo 3320, refaz o caminho quando ele se move, tenta outra casa se o servidor não mover a conta, olha para ele pelo 3301 ao chegar e, se ele sumir da sala, dá follow a cada 8 s: 3997 se for amigo, senão o comando `:follow` do Habblet), **Soltar alvo**, **Clicar** (quarteto 3301+431+2091+2138), **Andar** e **Olhar** para (x, y).
- **Quarto**: entrar pelo id (2230 "visitar" com tela, 2312 sem tela) e seguir um nick até o quarto dele.
- **Fala**: falar (1314), gritar (2085, header do Nitro padrão ainda não confirmado neste hotel), sussurrar (1543) e um seletor com os **comandos de chat que o próprio servidor anunciou às contas** (pacote 432: `:sit`, `:lay`, `:dance`, `:empty`…) mais argumentos.
- **Amizade e console**: pedir amizade (3157), aceitar todos os pendentes de cada conta (137), mensagem no console (3567) para um amigo.
- **Postura**: **Todas sentadas** / **Todas deitadas** — cada conta alvo lê os mobis do quarto em que está (pacote 1778 e as atualizações 1534/2703/3776), cruza com o furnidata do hotel para saber quais são sentáveis ou deitáveis (e quantas casas ocupam), escolhe a casa livre mais perto, anda até ela (3320) e o servidor a senta (`/sit` no 1640). Contas no mesmo quarto reservam casas diferentes; uma casa que não deu (o servidor não moveu, o caminho terminou antes, chegou e não sentou) sai da lista e a próxima é tentada; com tudo ocupado, espera até 60 s por um lugar vagar. **Levantar** dá um passo para uma casa vizinha livre. Sem furnidata (download falhou), só as casas onde alguém já foi visto sentado servem. O furnidata (17 MB) é baixado uma vez e guardado reduzido em `%APPDATA%\habblet-addall\furnidata.json`.

A linha de cada conta mostra a posição do avatar e em quem ela está fixada. O motor de perseguição é `FollowEngine` em `src/addons/protocol/engines.ts` (testado em `tests/follow.test.ts`); a geometria é a de vizinhança do jogo (distância de Chebyshev, diagonais valem). Os addons por protocolo (Add User All, Auto Message, sussurros, console, Auto Aceitar, Nudge) podem ser ligados para toda a multidão, usando as configurações do painel Addons. Cada conta pode ser pausada individualmente, e o botão **auto** na linha da conta a marca para conectar sozinha ao abrir o app (assim que o preload do webview estiver pronto).

**Login resistente a página lenta.** O app não decide no primeiro "carregou": sonda a página a cada 400 ms (até 30 s) até ver o formulário com os dois campos, o desafio do Cloudflare ou o hotel; o preenchimento espera os campos existirem (até 20 s), usa o setter nativo, confere que o valor pegou e, se não pegou, digita; falhas de rede ao carregar são repetidas em 10 s. Um vigia recomeça o login pela página inicial quando nada muda por 60 s (até 3 vezes) e o hotel é recarregado se o cliente não conectar. Só conta como "login recusado" quando o site mostra uma mensagem de erro.

**Uma tela por vez.** As telas das contas ocupam o mesmo espaço; em cima há um seletor (`TELA`) para trocar de conta. A tela selecionada fica visível, as outras continuam vivas fora da janela (nunca são recriadas, então trocar de conta não recarrega o jogo). O seletor mostra um ponto por conta (verde online, amarelo em captcha, vermelho em erro) e pula sozinho só quando a conta em foco sai; se você já está numa tela válida, a sua escolha é respeitada. Os `<webview>` das contas são criados à mão (`src/crowd/CrowdGuestHost.ts`), não pelo JSX do React: um webview montado pelo React sobre habblet.city cai no desafio cheio do Cloudflare, enquanto o criado por `createElement` (mesma partition/preload/UA) entra direto com o Turnstile passando sozinho — desde que o `src` seja definido antes de anexar ao DOM.

**Proxy por conta.** Cada conta pode ter um proxy próprio (`socks5://user:pass@host:porta`, `http://host:porta`), aplicado à sessão dela antes do primeiro request: site e WebSocket do jogo saem por ele, o que resolve o limite de conexões por IP. A URL do proxy é guardada criptografada. Na aba Proxies dá para definir por conta, distribuir uma lista em lote e testar o IP de saída de cada conta conectada. **Não troque o user agent da sessão:** um UA de Chrome "falso" (sem os client hints correspondentes) faz o Cloudflare desconfiar e servir o desafio cheio; o UA padrão do Electron entra direto.

**Captcha do Cloudflare, automático.** O login usa Turnstile. O comportamento depende da reputação do IP: com o IP "frio" (app recém-aberto, ou proxy de datacenter/Tor) as primeiras conexões caem na página de desafio inteira ("Um momento… / Confirme que é humano"); depois que algumas passam, novas contas costumam entrar limpas. Duas formas de passar, as duas já implementadas:

- **Serviço de resolução (sem clique).** Na aba Proxies → "Captcha automático", escolha **2Captcha** ou **CapSolver** e cole a chave da API (guardada criptografada). O app engancha o `turnstile.render` da página (`electron/webview-preload.ts`), captura sitekey/action/`chlPageData`, pede o token ao serviço (`electron/captcha-solver.ts`) e entrega ao widget — sem ninguém clicar. O 2Captcha resolve os dois casos (a página de desafio e o widget do login); o CapSolver só o widget do login.
- **Manual.** Sem serviço, a conta fica no estado **captcha**, a tela dela aparece no seletor destacada em amarelo, e você clica em "Confirme que é humano" uma vez; o app segue o login sozinho.

Custo/limite honesto: com o IP frio, praticamente toda conta bate no desafio no começo, então um serviço de resolução tem custo por conta (centavos) e ~10–30 s cada. Depois de aquecer o IP, o atrito cai.

**Sem tela (padrão): protocolo puro depois do login.** O cliente Nitro completo em cada conta baixa o bundle e os mobis de cada quarto pelo proxy (dezenas de MB por conta, mais a cada troca de quarto) e come memória de WebGL. No modo **sem tela** a página do jogo só faz o login: quando o `/hotel` carrega, o agente injetado devolve ao Nitro um **WebSocket falso** que "abre", captura o handshake que o cliente tenta mandar (4096 versão, 2490 machine id, 2419 ticket SSO) e o entrega ao app. O processo principal então abre o WebSocket do jogo por conta própria (`electron/headless-client.ts`, biblioteca `ws`, pelo proxy da conta, com SOCKS5 autenticado, coisa que o Chromium não faz), replica o handshake e emula o que o Nitro faria sozinho (pong, rajada pós-login, sequência de entrada em quarto, seguir amigo; tudo copiado de capturas reais, em `electron/headless-protocol.ts`). Assim que a conta autentica, a página do jogo é destruída. Os pacotes chegam ao renderer com a mesma forma dos do agente, então GameState, ações e motores não sabem a diferença; a coluna "Tela" fica vazia para essas contas e o consumo vira só protocolo (KB por minuto). Se a conexão cair, o app refaz o login sozinho em 20 s (desligável). O handshake nunca vai para o arquivo de captura. O servidor do jogo (`wss://game.habblet.city`, nginx, sem Cloudflare) aceita cliente Node com HTTP 101; **falta validar com uma conta real** que o ticket funciona vindo do cliente headless.

**Proxy depois do login.** O Habblet e o Cloudflare implicam com VPN e proxy no ato do login. Com o toggle ligado (aba Proxies), o site vê o IP real durante o login e o proxy da conta entra só depois de autenticada, restrito ao WebSocket do jogo (`game.habblet.city`): sem tela, o cliente Node conecta pelo proxy e a página do login fica direta; com tela, o proxy é aplicado à sessão antes de abrir o hotel. Também poupa o plano do proxy (login e bundle do cliente vão direto). Risco a observar no Log: se o servidor amarrar o ticket ao IP do login, a conexão cai logo após o handshake; nesse caso é desligar o toggle.

**Proxy só para o jogo.** Na aba Proxies, com "Proxy só para o jogo" ligado (padrão), um script PAC manda pelo proxy apenas os hosts listados (`habblet.city` e subdomínios, `challenges.cloudflare.com`); imagens, mobis e o resto vão direto pelo seu IP. É o que corta o consumo do plano no modo com tela e durante o login. "Testar IP" nesse escopo consulta o próprio site do Habblet, para mostrar o IP que o jogo vê.

**Tráfego.** A mesma aba mostra, por conta, quantos bytes de resposta HTTP saíram pelo proxy e quantos foram direto (aproximado pelo `content-length`, sem cache), os hosts que mais pesaram e os bytes do WebSocket no modo sem tela. Serve para ver para onde vai o plano do proxy e ajustar a lista de hosts. Com proxy autenticado (usuário e senha) a medição HTTP fica desligada: um listener de `webRequest` faz o Electron 35 derrubar o app inteiro quando o proxy responde 407 ao WebSocket do jogo (o WebSocket do modo sem tela continua medido).

**Modo Tor (grátis, um IP por conta).** Na aba Proxies há a seção "Tor (IP grátis por conta)". Como o Chromium não envia autenticação SOCKS5 (o truque de usuário por conta não isola), o app abre **uma SocksPort por conta** no Tor — o Tor isola circuitos por porta, então cada conta sai por um IP diferente. Fluxo: instale o Tor, ligue o modo, ajuste porta base e quantidade (>= nº de contas), clique em **Gerar torrc** e **Iniciar Tor** (ou informe o caminho do `tor.exe`), e conecte. Contas sem proxy próprio passam a sair "via Tor". Limites honestos: o Cloudflare marca saída Tor, então toda conta cai no captcha (deixe o resolvedor ligado), é lento e o Habblet pode bloquear nós de saída — serve para teste, não para uso sério. Código: `electron/tor.ts`.

**Proxy para uso real.** Proxies públicos gratuitos são instáveis e inseguros (podem ler/injetar tráfego), e o Cloudflare marca IP de datacenter/Tor. Para várias contas de verdade, use proxies **residenciais/móveis rotativos** com sessão fixa por porta (IPRoyal, Proxy-Cheap, Smartproxy/Decodo): cada porta = um IP estável por conta, o que evita o bloqueio por IP. Cadastre a URL (`socks5://user:pass@host:porta`) por conta ou em lote, e use "testar IP" para confirmar a saída. Um SOCKS5 seu num VPS (`ssh -D 1080 usuario@servidor`) serve para um IP estável de teste.

Código: `electron/crowd-store.ts` (cofre + config do resolvedor, rede e IPC), `electron/captcha-solver.ts` (2Captcha/CapSolver), `electron/crowd-proxy.ts` (proxy por sessão, PAC "só jogo", medidor de tráfego), `electron/headless-protocol.ts` (framing e emulação do cliente, puro e testado) e `electron/headless-client.ts` (WebSocket em Node pelo proxy), `src/crowd/CrowdManager.ts` (sessões, login, captcha, interceptação, transporte webview/sem tela, reconexão, comandos), `src/crowd/CrowdGuestHost.ts` (webviews imperativos), `src/crowd/useCrowdController.ts` (toda a ligação com o React: carga das contas, resolvedor, Tor, tela única, conexão automática e as props do painel; o App só renderiza), `src/crowd/loginScript.ts`, `src/components/CrowdPanel.tsx`, `src/addons/protocol/engines.ts` (motores como classes, um conjunto por sessão).

## Interface

Tema único **"Ink & Mint"**: fundo de tinta, superfícies em camadas discretas e um só acento (menta) para o que está vivo ou é ação principal. Tokens no `tailwind.config.js` (`bg`, `surface`, `raised`, `line`, `fg`, `muted`, `dim`, `accent`, `info`, `success`, `warn`, `danger`); nunca hex solto nos componentes. Fontes Inter Variable (interface) e JetBrains Mono (dados), empacotadas via `@fontsource`.

Layout: trilho esquerdo (marca em pixel art, Jogo, Logs, Board, Protocolo, Addons, indicador live), barra superior (URL em pílula com atalhos, status de conta e quarto, pedidos pendentes), jogo em tela cheia com chips do Add User All, dock inferior redimensionável e gaveta lateral de addons.

Atalhos: **Ctrl+K** foca a URL · **Ctrl+J** alterna o dock · **Ctrl+,** abre/fecha os addons. Funcionam mesmo com o foco dentro do jogo.

Para inspecionar a interface sem tocar na sessão real: `HABBLET_USER_DATA=<pasta> HABBLET_OPEN=addons npx electron .` abre uma instância isolada já com a gaveta aberta (`addons:<id>` abre a tela de um addon, `dock` abre o painel). Usado para capturas de tela e testes visuais.

## Persistência

As configurações são salvas automaticamente em `%APPDATA%\habblet-addall\config.json` (via `electron-store`):

- configuração de cada addon, gravada ao clicar em **Salvar**;
- quais addons estavam ativos, última URL carregada, tamanho e estado dos painéis;
- posição e tamanho da janela.

No painel **Addons**, **Exportar perfil** grava um `.json` com as configurações e **Importar perfil** carrega um arquivo desse tipo (só configs e layout; ativação e URL não são alteradas). Arquivos importados ou editados à mão passam por saneamento: chaves desconhecidas são ignoradas e valores inválidos voltam ao padrão.

## Aba Protocolo (sniffer do jogo)

O app injeta um **agente** na página do jogo antes de qualquer script do cliente Nitro. Ele substitui o `WebSocket` da página, separa cada frame em pacotes (`int32 tamanho` + `int16 header` + corpo) e envia tudo para a interface, que mostra na aba **Protocolo** do painel inferior:

- lista ao vivo com horário, direção (↓ entrada / ↑ saída), header, rótulo, tamanho e strings encontradas no corpo;
- filtros por direção, header e texto; opção de ocultar pacotes pequenos sem rótulo;
- detalhe do pacote com hex dump e strings; **Rotular** dá nome a um header (persistido e exportado no perfil);
- **Marcar** insere um marcador no momento de uma ação sua (ex.: "cliquei em Pedir Amizade") para correlacionar com os pacotes;
- **Internos** sonda o que o cliente expõe (globais como `NitroConfig`, URL do socket);
- **Enviar pacote** monta um corpo campo a campo (`i` int32, `s` int16, `b` byte, `t` string, `x` hex) e envia pela conexão ativa; **Reenviar** repete um pacote de saída capturado;
- **Exportar** grava a captura completa em JSON.

O que já foi mapeado do protocolo (headers, estruturas, sequências) está em [`docs/PROTOCOLO.md`](docs/PROTOCOLO.md). Toda sessão é gravada em `%APPDATA%\habblet-addall\captures\*.ndjson`; os scripts em `tools/protocol/` analisam esses arquivos. O agente guarda até 4 MB de corpo por pacote (a lista de amigos de uma conta com ~6 mil amigos passa de 300 KB); acima disso o pacote vai marcado como truncado e os decodificadores aproveitam o que couber.

Caminho dos dados: página (agente, main world) → `window.postMessage` → `electron/webview-preload.ts` (isolated world) → `ipcRenderer.sendToHost` → renderer. Comandos fazem o caminho inverso com `webview.send`. A página do jogo nunca tem acesso ao `ipcRenderer`.

## Aba Jogo (estado por protocolo)

A aba **Jogo** mostra o que o app entende do jogo só pelos pacotes, sem ler a tela: quem você é, a sala atual com todos os usuários (id, índice, posição, digitando, última fala), sua lista de amigos com quem está online, pedidos de amizade pendentes e um log de eventos (chat, entradas e saídas, amizades, avisos do servidor). Dali dá para agir por protocolo: **+ amigo** envia o pedido (3157), **Aceitar** aceita (137), **Entrar** troca de quarto (2312).

**Copiar quarto.** O botão grava um JSON com tudo o que o app sabe do quarto atual: planta (1301, `x` = sem chão), porta (pedida ao servidor na hora, 3559 → 1664), pintura (2454), altura do topo de cada casa (2753), todos os mobis de chão (1778 e atualizações: tipo, nome do furnidata, posição, direção, altura, estado) e de parede (1369: tipo, posição na parede, estado), mais uma lista de compras por tipo com a oferta do catálogo (`offerId`; -1 = não está à venda). É a etapa "Ctrl+C" do clone de quarto. Código: `src/protocol/roomCopy.ts`.

**Colar quarto.** O botão ao lado abre um cartão no lugar dos eventos: escolha o JSON, ajuste as opções (aplicar planta, comprar o que faltar, colocar os mobis, aplicar pintura) e clique em **Preparar prévia**. O app pede o inventário (3150 → 994) e o índice do catálogo (1195 → 1032), desconta o que você já tem, resolve a página de cada mobi pelo índice (o `offerid` do furnidata é a chave que o índice usa para apontar a página; a oferta que se compra é a da página, achada pelo produto), lê as páginas necessárias (412 → 804) para os preços e mostra a prévia: quantas compras, total em créditos e pontos, o que não está à venda. **Nada é comprado antes de você confirmar.** Depois: compra (3492) uma oferta por vez esperando o 869 (no máximo 100 unidades por compra: 483 de um mesmo mobi viram 100, 100, 100, 100 e 83), recarrega o inventário, salva uma **planta de obra** (875; o servidor reentra no quarto) — exatamente o piso padrão (64×64 todo em altura 0, porta no canto 63,63 para o avatar nascer fora do caminho, parede na altura máxima 15; com 16 o servidor ignora o pedido): toda coordenada existe, porque muita gente decora e depois tira o piso por baixo e o servidor recusa colocar onde não há chão; sobre o piso 0, tudo o que no JSON está acima de 0 vai pela casa de apoio com `:up` —, coloca os mobis em ordem de altura (1258) esperando cada 1534/2187 — quando a casa de destino já tem mobi, ou a altura pedida não é a do piso (pilhas, mobis flutuando), o mobi é colocado numa **casa de apoio livre** e levado ao destino num único mover com `:up N` ligado, que é o que permite empilhar onde o servidor recusaria a colocação direta — e **confere cada um ao aparecer**. O estado vai **armado antes da colocação** com `:state N`, porque `:state` só vale no 1258 (mover com ele ligado não muda nada); se altura ou rotação vieram diferentes (o servidor nem sempre respeita a rotação pedida na colocação), liga `:up N` e manda um único mover (248) com a rotação certa, conferindo o 3776; um estado que ainda assim vier errado é corrigido "usando" o mobi (99, o duplo clique) até bater. Estados de parede vão com "usar" (210) até bater. No fim vêm **duas** passadas de conferência, e as duas percorrem todo mobi colocado comparando posição, altura, rotação e estado com o JSON: a **verificação** refaz o que estiver diferente ainda sobre o piso plano da obra; depois a pintura (711) e a **planta real** do JSON; e então o **refino**, que confere tudo de novo — desta vez com o piso definitivo no lugar. O refino existe porque trocar a altura do chão faz o servidor reassentar o que está em cima: antes isso só era relatado (`movedOnFloorPlan`) e a colagem terminava com mobis na altura errada. Cada mobi tem até três tentativas por passada (o servidor às vezes ignora a rotação num mover e aceita no seguinte).

**Conferência por coordenada.** As duas passadas são dirigidas por uma conferência que percorre o **JSON**, mobi por mobi, e pergunta de cada um: na casa (x, y) que o original pede, está o mobi certo, na altura certa, na rotação certa e no estado certo? O veredicto de cada item é um de `ok`, `missing` (a casa está vazia — não foi colocado), `wrong-type` (a casa tem outro mobi), `wrong-position` (o mobi que colocamos para ele está em outra casa), `wrong-z`, `wrong-direction`, `wrong-state` ou `state-not-checkable` (o estado difere mas o protocolo não deixa ajustar: placares, wireds). Os quatro do meio a passada conserta; os outros ela relata com a coordenada.

Isso corrige uma falha real do check anterior, que percorria apenas `placements` — a lista do que o motor colocou *nesta execução*. Um mobi que nunca chegou a ser colocado (inventário esgotado, prazo estourado) ou que veio de uma execução anterior não estava em lista nenhuma e **passava batido**: a colagem terminava dizendo que estava tudo certo. Agora a fonte da verdade é o JSON, então "faltou colocar em (12, 30)" é um resultado possível.

O cartão mostra o resultado (quantos conferem, quantos faltam, quantos estão fora do lugar, quantos sobram no quarto) com a lista das divergências, e **Exportar conferência** grava um `.txt` com todas elas e suas coordenadas. O mesmo resumo vai para o log e para a frase final: `Conferência por coordenada: 812 de 814 mobis do JSON conferem; 2 faltam colocar e 0 ficaram diferentes`. Para completar os que faltam, rode a colagem de novo com **Continuar construção**: eles não casam com nada e entram na fila normal de compra e colocação. Código: `auditRoom` / `auditReportText` em `src/protocol/roomPaste.ts`, com `matchRoomItems` como regra única de casamento (a retomada e a conferência usam a mesma, para nunca discordarem). Quando não há nada a colocar (quarto já pronto), a planta de obra é dispensada: trocar o piso duas vezes de graça só faria o servidor remexer no que já está certo. O valor do `:up` é **relativo ao piso da casa de destino** (lote em 20 + `:up 6` = 26): o motor manda `altura − piso`; se o servidor se comportar como altura absoluta, ele percebe no primeiro ajuste que estoura o prazo e troca. Os modos `:up`/`:state` ficam ligados entre mobis seguidos com a mesma altura e estado (os mobis são colocados em ordem de altura e estado para isso); o `:up` é desligado antes de uma colocação direta e ambos no fim; o ritmo (respiro entre passos já confirmados) é escolhido no cartão: rápido, normal ou seguro. A lista **Ignorar mobis** deixa de fora, da compra e da colocação, o que casar por prefixo ou nome da classe do furnidata (`wf_` = todos os wireds) ou pelo id do tipo; se o servidor colocar um tipo diferente do pedido, o relatório marca "tipo trocado" e o log diz qual. Cada passo tem prazo; o que falhar entra no relatório final. A colagem vive fora do cartão: fechar o "Colar quarto" ou trocar de aba não a interrompe (o botão mostra a fase e o andamento enquanto ela roda); só o Cancelar para. Só funciona em quarto seu (o servidor precisa ter mandado o 339). Código: `src/protocol/roomPaste.ts` (máquina de estados pura, testada em `tests/roomPaste.test.ts`) e `src/components/RoomPaste.tsx`.

**Continuar construção.** Se a colagem parar no meio — queda da sessão, falta de energia, cancelamento, o app fechado — é só entrar no quarto, subir **o mesmo JSON** e preparar a prévia de novo: com a opção **Continuar construção** ligada (padrão), o app confere o JSON contra o quarto antes de comprar qualquer coisa e refaz o plano só com o que falta. Não há arquivo de progresso; o próprio quarto é o registro. Um mobi do JSON conta como feito quando existe no quarto um do **mesmo tipo na mesma casa** (parede: mesma posição); numa pilha de mobis iguais na mesma casa, casa primeiro o de altura mais próxima. Altura, rotação e estado diferentes **não** impedem o casamento: o mobi já existe, entra direto na verificação final e é acertado sem comprar outro — então a prévia mostra "X já no quarto" e a lista de compras cai para o que realmente falta. É conservador de propósito: **nada que já está no quarto é movido de casa nem recolhido**. Um mobi que a interrupção deixou numa casa de apoio não casa com nenhuma posição do JSON, aparece como "fora do JSON" na prévia e fica onde está (o motor coloca outro no destino — melhor pagar um mobi a mais do que mexer na mobília de alguém). Com o quarto vazio nada muda; com o quarto pronto, a colagem vira só uma **refinaria**: nenhuma compra, nenhuma colocação, nenhuma troca de planta — só as duas passadas de conferência acertando altura, rotação e estado de cada mobi contra o JSON. A pintura que já está aplicada também não é reaplicada. Desligue a opção para forçar a colagem do zero.

Código: `src/protocol/nitro/` (headers, decodificadores e compositores), `src/protocol/state/GameState.ts` (estado alimentado pelos pacotes), `src/protocol/actions.ts` (ações).

## Estrutura

```
electron/main.ts              Processo principal do Electron (janela, popups do webview)
electron/preload.ts           Ponte segura entre main e renderer (contextBridge)
electron/store.ts             Persistência em disco (electron-store) e estado da janela
electron/webview-preload.ts   Preload do <webview>: injeta o agente e faz a ponte agente ↔ renderer
electron/webview-agent.ts     Agente que roda na página do jogo (hook do WebSocket, parsing, envio, sondagem, socket falso do modo sem tela)
electron/headless-protocol.ts Framing em Buffer + emulação do cliente Nitro (pong, rajadas, entrada em quarto) — puro, testado
electron/headless-client.ts   Cliente do jogo sem tela: WebSocket em Node pelo proxy da conta, um por conta
electron/crowd-proxy.ts       Proxy por partition (fixed ou PAC "só jogo"), teste de IP, medidor de tráfego por host
shared/protocol.ts            Tipos das mensagens do agente e dos comandos
src/protocol/                 Hook de captura (useProtocolCapture), decodificação, nitro/ (headers, parsers, composers), state/ (GameState), actions
src/components/GamePanel.tsx  Aba Jogo
src/components/ProtocolPanel.tsx  Aba Protocolo
shared/ipc.ts                 Canais e API IPC compartilhados entre main e renderer
shared/addon-config.ts        Tipos, padrões e saneamento das configs dos addons
src/App.tsx                   Shell da interface (URL, webview, stats, painel inferior); sem código por addon
src/addons/registry.tsx       REGISTRO: cada addon declarado uma vez (nome, config padrão, motores, script DOM, tela)
src/addons/types.ts           AddonDefinition e props uniformes das telas de settings
src/addons/useAddonStore.ts   Estado de todos os addons (config, ativação, dirty, último salvo) + persistência
src/addons/dom/               Carregamento/ativação dos scripts DOM e polling, dirigidos pelo registro
src/addons/protocol/          Motores por protocolo (um hook por addon) e o hook que liga todos ao store
src/pages/AddonsOverlay.tsx   Cards e roteamento das telas a partir do registro
src/pages/Settings*.tsx       Só os campos de cada addon, dentro de SettingsShell
src/components/               SettingsShell (moldura, Section, TagListEditor, EngineToggle), Board, inputs
src/crowd/                    Multidão: CrowdManager (sessões), CrowdGuestHost (webviews), useCrowdController (ligação com o React)
public/scripts/*.js           Scripts injetados no webview (um por addon)
tests/                        Vitest: helpers de pacotes sintéticos + testes de decode, parsers, GameState e motores
tools/protocol/               replay_state (captura real → GameState), analyze_capture.py, live_digest.py
tools/build-stamp.mjs         Gera shared/build-info.ts (marca do build) no build e no dev
tools/verify-pack.mjs         Guarda do pack: recusa empacotar com o app aberto e confere o asar depois
shared/build-info.ts          GERADO: data/hora e modo da compilação em execução
.github/workflows/ci.yml      CI: lint, typecheck, testes e build
```

## Como adicionar um addon

1. Em `shared/addon-config.ts`: tipo da config, padrão, `AddonId`, entradas em `AddonConfigMap`, `defaultAddonConfigs` e `defaultSettings.enabled`.
2. Tela de settings em `src/pages/SettingsX.tsx` usando `SettingsShell` e as props `AddonSettingsProps<Config>`.
3. Motor por protocolo (hook em `src/addons/protocol/`) ligado em `useAllProtocolEngines.ts`, e/ou spec do script DOM.
4. Uma entrada em `src/addons/registry.tsx`. Cards, toggle, persistência, perfil e roteamento vêm de graça.

## Como os addons funcionam

A interface carrega cada script via `fetch` e o injeta no webview com `executeJavaScript`. A configuração é passada por variáveis globais da página (ex.: `window.__ADDALL_CONFIG__`) e os scripts publicam estatísticas e logs em `window.__ADDALL_STATS__`, `window.__ADDALL_LOGS__` etc., que a interface lê periodicamente.
