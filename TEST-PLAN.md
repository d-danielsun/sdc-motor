# TEST-PLAN — Console do financeiro (#13) + endurecimento (#15) e alertas (#14)

> Um por feature, versionado na branch, junto do código — vive dentro do PR.
> §1/§2/§4/§5 são o de sempre (o que mudou, roteiro, evidência, follow-ups).
> A §3 (caça-unknowns) é o passo obrigatório: o que só aparece USANDO.
>
> **Reescrito em 11/09/2026.** A versão anterior descrevia o sistema pré-#13 — falava de
> `CONSOLE_TOKEN` como credencial do console e de `x-user` como identidade, dois contratos que
> morreram quando o login por sessão entrou. Um plano de teste que descreve um sistema que não
> existe mais é pior que nenhum: ele dá a sensação de cobertura sem cobrir nada.

## 1. O que foi implementado  (o MAPA)

Fatura postada no Odoo vira 1 boleto Asaas por parcela; `PAYMENT_RECEIVED` vira baixa na parcela
exata; o que foge do trilho vira exceção. **O console em `/console/` é a superfície humana disso**:
login próprio com sessão, fila de exceções com as quatro ações, saúde do motor, configuração e
cobranças. Alerta crítico por e-mail avisa quando algo trava sem ninguém olhando.
· Spec: `~/w/salvei/propostas/SDC/02-SPEC.md` v1.1

**Superfícies:** SPA sem build em `public/` (`app.js`, `style.css`) · `src/app/console.ts`
(sessão, `/session`, `/me`, ações, `/jobs/:name` para o cron) · read model em
`src/core/console.ts` + `src/adapters/db/console.ts` · `db/migrations/0005`–`0008` · CLI
`console-user` · modo demo (`src/cli/demo.ts`).

**Personas:** **Fernanda (financeiro SDC)** opera a fila pelo navegador, com teclado e mouse, e é
quem recebe o alerta às 3h. **Dan (operador)** cria acesso, roda jobs e migrations. **Asaas** e
**Odoo** batem nos webhooks.

**Deploy:** `npm run db:migrate` ANTES do código; o motor recusa subir com migration pendente.
Identidade do console é **sessão em cookie** — `CONSOLE_TOKEN` sobrevive só em `POST /jobs/:name`,
o cron externo (a afirmação "sem CONSOLE_TOKEN a API responde 503" está morta desde a #13; ver
§5-F4). Atualização de motor **já no ar**: desligue as regras do Odoo antes de migrar
(`db/migrations/down/LEIA-ME.md`, regra 3).

## 2. Roteiro de verificação  (território CONHECIDO — o agente executa)

> Executado em 11/09/2026 contra `main @ c3c22de` + este branch, no Chromium via Playwright,
> com o motor no `motor_demo` semeado por `npm run demo -- tudo`. **Navegador de verdade, não
> teste estático** — foi trocar um pelo outro que deixou um P1 de renderização passar na #13.

### 2.1 o que o P1 do review quebrava (regressão visual)
- [x] [AUTO] `/console/` mostra **só** o cartão de login — `.painel` e `#confirma` computam
      `display:none`, e todo elemento com `[hidden]` também (era o bug: `[hidden]` perdia do
      `display:grid` na cascata, e login + painel vazio + diálogo apareciam juntos)
- [x] [AUTO] o diálogo de confirmação abre com título, texto e **rótulo preenchido** no botão
      vermelho (antes ele nascia visível e em branco)
- [x] [AUTO] `DIFERENÇA A ACEITAR` é laranja, não azul — é a única exceção que gera escrita
      irreversível no ERP, e azul é a cor de "nada a fazer"

### 2.2 login e sessão
- [x] [AUTO] senha errada → "E-mail ou senha incorretos.", sem dizer se o e-mail existe, e sem sessão
- [x] [AUTO] senha certa → entra, o cartão de login some, cai em `#/excecoes`
- [x] [AUTO] cookie `sdc_session` é `HttpOnly` + `SameSite=Lax`, e `document.cookie` volta vazio
- [x] [AUTO] `sair` volta ao login e o cookie deixa de valer (`/exceptions` → 401)
- [x] [AUTO] freio de tentativas e teto de concorrência — cobertos em `test/db/console-auth.test.ts`
      (martelar o login no navegador só reexecutaria a suíte; o teto agora é testado com o freio
      desligado, senão os dois 429 são indistinguíveis)

### 2.3 fila de exceções
- [x] [AUTO] lista as abertas com tipo, cliente, valor e data; filtros de status e tipo populados
- [x] [AUTO] clicar abre o painel de detalhe com o `detail` legível e o motivo em destaque
- [x] [AUTO] **a URL acompanha**: abrir escreve `#/excecoes/:id`, fechar limpa (corrigido — §3 U4)
- [x] [AUTO] `#/excecoes/:id` numa aba nova abre aquele detalhe direto (é o link do e-mail de alerta)
- [x] [AUTO] `#/excecoes/999999` → "Não achei o item 999999 — ele pode ter sido removido."
- [x] [AUTO] `#/excecoes/abc` → cai na lista, sem tela quebrada
- [x] [AUTO] **operável por teclado**: a linha recebe Tab, tem `role=button` e abre no Enter
      (corrigido — §3 U3)

### 2.4 as quatro ações
- [x] [AUTO] `resolver` / `ignorar` / `reprocessar` disparam um POST e recarregam a fila
- [x] [AUTO] triplo clique real em `ignorar` manda **um** POST só (o `disabled` segura)
- [x] [AUTO] `aceitar diferença` — a única que escreve no ERP — exige confirmação, com o texto
      dizendo que mexe no Odoo e não se desfaz
- [x] [AUTO] o foco nasce em `cancelar`, nunca no botão destrutivo
- [x] [AUTO] `Escape` com o diálogo aberto **cancela o diálogo**, mantém o painel e devolve o foco
      ao botão que o abriu (corrigido — §3 U1, era o bloqueador)
- [x] [AUTO] o foco fica preso no diálogo enquanto ele decide (corrigido — §3 U2)

### 2.5 saúde, configuração e cobranças
- [x] [AUTO] o card da fila do Asaas nos **quatro** estados: `PARADA · penalizações: 15` ·
      `ok · penalizações: 0` · `sem webhook · registre com o job register-asaas-webhook` ·
      `estado desconhecido · não consegui consultar o Asaas agora` (este último visto ao vivo, com
      chave inválida — antes ele mentia "ok" quando a consulta falhava)
- [x] [AUTO] saúde mostra emissão, aging nas 4 faixas, exceções por tipo, últimos jobs
- [x] [AUTO] configuração lista os 4 gates com a explicação do que cada um faz
- [x] [AUTO] cobranças lista com rodapé de paginação
- [ ] [MANUAL] **paginação keyset com mais de uma página** — o demo semeia 7 cobranças, uma página
      só; `próxima` nunca foi exercitada no navegador. Coberto por `test/db/console.test.ts`, não
      por olho.
- [ ] [MANUAL] **`ligar notificações para todos`** — o card existe e o diálogo confirma, mas clicar
      chama o Asaas de verdade; sem chave de sandbox nesta máquina, o caminho de sucesso não foi
      exercitado (o de falha, sim: vira aviso na tela).

## 3. CAÇA-UNKNOWNS  (o território — o DIFÍCIL, só usando aparece)

- **U1 (BLOQUEADOR, corrigido): `Escape` deixava o diálogo órfão, e o botão que escreve no ERP
  continuava vivo.** Abrir uma exceção `writeoff_needed` → `aceitar diferença` → `Escape`: o
  listener global de Escape fechava o **painel debaixo**, o diálogo ficava flutuando sobre a
  lista, e a promessa de `confirmar()` nunca resolvia. Clicar em `aceitar e baixar` ali disparava
  `POST /exceptions/3/accept-writeoff` — a baixa irreversível no Odoo de uma exceção que o
  operador acabara de dispensar. Reproduzido no navegador, evidência em §4. Corrigido: o diálogo
  captura o próprio Escape e cancela; o Escape global só fecha o painel com o diálogo fechado.
- **U2 (corrigido): o diálogo não prendia o foco.** Tab saía na primeira parada e passeava pela
  página coberta — teclado indo aonde o olho não vai, com um botão de escrita no ERP aberto.
- **U3 (corrigido): a fila de exceções não era operável por teclado.** As linhas eram `div` com
  `onclick`: sem Tab, sem Enter, sem anúncio de que dá para acionar. As ações eram alcançáveis,
  mas não dava para **escolher** uma exceção sem mouse — para quem opera a fila o dia inteiro,
  isso é o produto inteiro atrás do mouse.
- **U4 (corrigido): o deep-link só funcionava de entrada.** Clicar numa exceção abria o painel e
  deixava a URL em `#/excecoes`: não dava para copiar o link do que se estava vendo, F5 perdia o
  lugar e o botão voltar não fechava o painel. O `fecharPainel` **já limpava** um id do hash que
  ninguém nunca escrevia — a metade de saída nunca existiu.
- **U5 (corrigido, veio de graça): teste que reprova sozinho todo dia às 09:59.** Ao rodar a suíte
  depois das 10h, `o diário limpa sessão expirada` reprovou — no `main` limpo também. A sessão
  "vencida ontem" nascia de `Date.now()` (tempo real) e era purgada contra o clock fixo do mundo
  (2026-09-10T13:00Z): só passava enquanto o relógio real estivesse antes de 12:59 UTC. Estava na
  linha **logo abaixo** do comentário que avisa sobre misturar os dois relógios. Quinta ocorrência
  desta família no repo.
- **U6 (não corrigido, decisão de produto): o demo não é fixture congelado.** Com `npm run dev` no
  ar, o scheduler roda contra o `motor_demo` e muda o que está na tela — durante este QA, a
  exceção `writeoff_needed` desapareceu sozinha e uma `payment_unmatched` nova apareceu. Para
  demonstrar ao cliente, os 6 cenários semeados não são o que vai estar na tela cinco minutos
  depois. → §5

## 4. Evidência

- Suíte: **244 testes verdes**, typecheck limpo nos dois projetos (`tsconfig.json` + `tsconfig.test.json`).
- Navegador: Chromium via Playwright, roteiro §2 dirigido por script, 15 screenshots.
  As correções de U1–U4 foram **reverificadas no navegador depois do patch** — os quatro voltaram
  verdes, com `getComputedStyle` e captura de requisição como afirmação, não com o olho.
- Mutação: as regressões novas de `console-spa.test.ts` reprovam quando o helper `itemClicavel` ou
  o `history.replaceState` saem do `app.js`.
- Zero `pageerror` no console do navegador em todo o roteiro.

## 5. Follow-ups

- **F1 — [MANUAL] paginação keyset com 2+ páginas nunca foi vista no navegador.** Precisa de um
  cenário de demo com mais de 20 cobranças, ou de semear à mão. Coberto por teste de banco.
- **F2 — [MANUAL] `ligar notificações para todos` no caminho de sucesso.** Precisa da chave de
  sandbox do Asaas, que não existe nesta máquina (é um dos itens que o Dan guardou para o final).
- **F3 — o demo drifta com o motor no ar (U6).** Opções: subir o motor sem scheduler para
  demonstração, ou congelar o demo num banco que o scheduler não toca. Decisão de produto.
- **F4 — `.env.example` ainda diz "CONSOLE_TOKEN — sem ele a API /api/v1 responde 503".**
  Contrato morto desde a #13; o runbook já foi corrigido no review, o `.env.example` ficou. → corrigido neste PR.
- **F5 — `resolver` e `ignorar` não confirmam.** São reversíveis no banco, mas **não há tela** para
  reabrir uma exceção ignorada: na prática é porta de mão única por um clique errado. Não é
  bloqueador; vale decidir se ganha confirmação ou se o console ganha "reabrir".
- **F6 — falha de ação mostra "internal error" cru** para o operador. Mensagem que não diz o que
  fazer é a mesma classe do 500 opaco que o review já fechou em outro caminho.
