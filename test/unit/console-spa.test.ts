// A SPA não tem build nem framework, então também não tem compilador para pegar erro de
// digitação. Estes testes cobrem as duas classes de bug que sobram e que só aparecem em
// runtime, na frente de quem está demonstrando:
//   1. `$("algum-id")` de um id que não existe no HTML → null e a tela quebra em silêncio.
//   2. a UI chamar uma rota que a API não tem → 404 no meio de um clique.
// A segunda é a regra "a UI não inventa contrato", virada em teste.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const leia = (f: string) => readFileSync(path.resolve("public", f), "utf8");
const html = leia("index.html");
const app = leia("app.js");
const css = leia("style.css");
const consoleTs = readFileSync(path.resolve("src/app/console.ts"), "utf8");

const idsNoHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] as string));

describe("SPA do console", () => {
  it("todo $(\"id\") do app.js existe no index.html", () => {
    const usados = [...app.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1] as string);
    expect(usados.length).toBeGreaterThan(15);
    expect([...new Set(usados)].filter((id) => !idsNoHtml.has(id))).toEqual([]);
  });

  it("todo id do HTML é usado pelo app.js ou pelo CSS — nada de elemento órfão", () => {
    const orfaos = [...idsNoHtml].filter((id) => !app.includes(`"${id}"`) && !css.includes(`#${id}`));
    expect(orfaos).toEqual([]);
  });

  it("toda rota que a UI chama existe na API (a UI não inventa contrato)", () => {
    // Rotas declaradas em src/app/console.ts, montadas em /api/v1.
    const declaradas = [...consoleTs.matchAll(/api\.(get|post|put|delete)\("([^"]+)"/g)]
      .map((m) => ({ metodo: (m[1] as string).toUpperCase(), caminho: m[2] as string }));
    expect(declaradas.length).toBeGreaterThan(10);

    // Chamadas da UI: api("/caminho", { method }) e o fetch cru do login.
    const chamadas = [...app.matchAll(/\bapi\(\s*[`"]([^`"]+)/g)].map((m) => (m[1] as string).split("?")[0] as string);
    chamadas.push("/session");   // o login usa fetch direto para poder ler o 429
    // As telas do issue dependem destas; se alguma sumir do app.js, a tela ficou órfã.
    for (const obrigatoria of ["/exceptions", "/charges", "/health-report", "/dashboard", "/config", "/me", "/session"]) {
      expect(chamadas.some((c) => c.startsWith(obrigatoria)), `a UI não chama ${obrigatoria}`).toBe(true);
    }

    // Compara segmento a segmento. Vale como igual quando os dois lados são literais iguais,
    // ou quando um deles é variável: `:id` na rota e `${e.id}` na chamada.
    const segmentos = (s: string) => s.split("/").filter(Boolean);
    const variavel = (seg: string) => seg.startsWith(":") || /\$\{/.test(seg);
    const casa = (chamada: string) =>
      declaradas.some((d) => {
        const a = segmentos(chamada), b = segmentos(d.caminho);
        return a.length === b.length && a.every((seg, i) => variavel(seg) || variavel(b[i] as string) || seg === b[i]);
      });
    expect([...new Set(chamadas)].filter((c) => !casa(c))).toEqual([]);

    // O curinga acima aceitaria uma ação inventada em `/exceptions/:id/${x}`. Estas são as
    // quatro que existem, e o app.js não pode ter outra.
    const acoes = [...app.matchAll(/acao\("[^"]+", "([^"]+)"/g)].map((m) => m[1] as string);
    expect(acoes.sort()).toEqual(["accept-writeoff", "ignore", "reprocess", "resolve"]);
    for (const a of acoes) expect(consoleTs, `a API não tem /exceptions/:id/${a}`).toContain(`/exceptions/:id/${a}`);
  });

  it("href de dado do servidor passa por validação de esquema (P3 do verificador)", () => {
    // `href` é o único atributo em que dado do servidor não é texto: um `javascript:` vindo
    // de um boleto viraria execução no clique.
    expect(app).toContain("const urlSegura =");
    for (const m of app.matchAll(/href:\s*([A-Za-z_$][\w.$]*)/g)) {
      const variavel = m[1] as string;
      expect(["boleto", "boletoUrl"], `href: ${variavel} não passou por urlSegura`).toContain(variavel);
    }
    expect(app).not.toMatch(/href:\s*ch\.bankSlipUrl/);
  });

  it("nenhum dado do servidor entra por innerHTML", () => {
    // Nome de cliente e mensagem de erro vêm do Odoo e do Asaas: montar com textContent é o
    // que impede que um cadastro com `<script>` vire execução na tela do financeiro.
    expect(app).not.toMatch(/\.innerHTML\s*=/);
    expect(app).not.toMatch(/insertAdjacentHTML|document\.write|eval\(/);
  });

  it("o app.js é JavaScript válido para o navegador", () => {
    // `node --check` não roda aqui, então o parser do próprio runtime faz o papel: `new
    // Function` compila sem executar. Pega erro de sintaxe, que num arquivo sem build seria
    // uma tela branca.
    expect(() => new Function(app)).not.toThrow();
  });

  it("as 4 telas do issue existem, e cada uma tem rota no hash router", () => {
    for (const tela of ["excecoes", "cobrancas", "saude", "config"]) {
      expect(idsNoHtml.has(`tela-${tela}`), `falta a seção da tela ${tela}`).toBe(true);
      expect(html, `falta o link de ${tela}`).toContain(`href="#/${tela}"`);
      expect(app, `falta a rota ${tela} no roteador`).toMatch(new RegExp(`\\b${tela}:\\s*\\{\\s*secao`));
    }
  });

  it("as ações destrutivas passam por confirmação, com texto do que vai acontecer", () => {
    // accept-writeoff mexe no ERP; IDA_ENABLED faz boleto sair; enable-notifications dispara
    // cobrança para todo mundo. As três abrem um diálogo com título, texto e rótulo do botão.
    // A janela olha para TRÁS também. Olhando só para frente, o que este teste achava era a
    // DEFINIÇÃO de `confirmar()`, lá embaixo no arquivo — não a chamada. Ele passou por acaso
    // até um comentário empurrar a definição para fora dos 900 caracteres, e aí "reprovou" uma
    // confirmação que sempre existiu. Proximidade em texto-fonte mede distância, não intenção:
    // por isso agora exige a CHAMADA (`await confirmar(`) perto do uso.
    const corpoDaFuncao = app.slice(app.indexOf("function confirmar("));
    for (const trecho of ["accept-writeoff", "IDA_ENABLED", "enable-notifications"]) {
      const posicoes = [...app.matchAll(new RegExp(trecho.replace(/[-/]/g, "\\$&"), "g"))].map((m) => m.index ?? 0)
        .filter((i) => i < app.indexOf("function confirmar("));   // ocorrências no código, não na própria função
      expect(posicoes.length, `${trecho} não aparece no app.js`).toBeGreaterThan(0);
      const temDialogo = posicoes.some((i) => /await confirmar\(/.test(app.slice(Math.max(0, i - 900), i + 900)));
      expect(temDialogo, `${trecho} sem chamada a confirmar() por perto`).toBe(true);
    }
    // e o diálogo só resolve `true` no botão de confirmar, nunca por padrão
    expect(corpoDaFuncao).toMatch(/ok\.onclick = \(\) => fim\(true\)/);
    expect(corpoDaFuncao).toMatch(/cancelar\.onclick = \(\) => fim\(false\)/);
    // Escape dentro do diálogo CANCELA — não pode cair no listener global, que fecha o painel
    // debaixo e deixa a confirmação órfã (achado do /qa-gate, reproduzido no navegador).
    expect(corpoDaFuncao).toMatch(/Escape[\s\S]{0,120}fim\(false\)/);
    expect(app).toMatch(/keydown[\s\S]{0,120}Escape[\s\S]{0,80}confirma"\)\.hidden/);
  });

  // Os três achados do /qa-gate de 11/09/2026, reproduzidos no navegador com Playwright. Estes
  // testes são de TEXTO-FONTE — a suíte não renderiza — então valem como trava contra remoção
  // acidental, não como prova de que funciona. A prova está nas evidências do TEST-PLAN §4.
  it("a linha de lista é operável por teclado (qa-gate U3)", () => {
    // `div` com onclick não recebe Tab e não responde a Enter: quem opera a fila o dia inteiro
    // ficava obrigado a usar o mouse para CADA exceção.
    expect(app, "o helper de linha clicável sumiu").toMatch(/const itemClicavel = /);
    const helper = app.slice(app.indexOf("const itemClicavel = "), app.indexOf("const itemClicavel = ") + 600);
    expect(helper).toMatch(/role: "button"/);
    expect(helper).toMatch(/tabindex: "0"/);
    expect(helper, "Enter/Espaço não acionam a linha").toMatch(/onkeydown[\s\S]{0,120}Enter/);
    // e as duas listas usam o helper, em vez de cada uma reinventar a linha
    expect([...app.matchAll(/itemClicavel\(/g)].length, "alguma lista voltou a montar a linha na mão").toBeGreaterThanOrEqual(2);   // exceções e cobranças
    expect(app).not.toMatch(/el\("div", \{ class: "item", onclick/);
  });

  it("abrir um item escreve o id na URL (qa-gate U4)", () => {
    // O `fecharPainel` sempre limpou este id do hash — só que ninguém o escrevia, então a metade
    // de SAÍDA do deep-link nunca existiu: não dava para copiar o link do que se estava vendo.
    const abrir = app.slice(app.indexOf("async function abrirExcecao("), app.indexOf("async function abrirExcecao(") + 700);
    expect(abrir).toMatch(/history\.replaceState\(null, "", `#\/excecoes\/\$\{e\.id\}`\)/);
    expect(abrir, "usar location.hash aqui acorda o roteador e reabre o painel").not.toMatch(/location\.hash = /);
  });

  it("o fetch manda o cookie e o content-type que a API exige", () => {
    expect(app).toContain('credentials: "same-origin"');
    expect(app).toContain('"content-type": "application/json"');
  });

  it("a página não some do ar por causa da política de indexação nem carrega CDN", () => {
    expect(html).toContain('name="robots"');
    // Sem build significa sem dependência externa: nada de <script src=http…>.
    expect(html).not.toMatch(/<(script|link)[^>]+(https?:)?\/\//);
  });
});

describe("o atributo hidden precisa ganhar da cascata (review #15)", () => {
  it("existe uma regra [hidden] que vence as classes com display", () => {
    // O BUG QUE ISTO PEGA, e que nenhum outro teste pegava: `hidden` só esconde porque a folha
    // do NAVEGADOR diz `[hidden]{display:none}`, e qualquer regra nossa de `display` ganha dela.
    // `.login` e `.painel` setam `display:grid`, então a tela de login, o painel de detalhe VAZIO
    // e o diálogo de confirmação com um botão vermelho em branco apareciam todos ao mesmo tempo,
    // desde o primeiro pixel — e todo `el.hidden = true` do app.js era inerte. Achado pela review
    // de design; invisível para teste que não renderiza, e é por isso que este é estático.
    // Comentários fora: o comentário que explica o bug cita `[hidden]{display:none}` e casaria
    // com o regex, fazendo o teste passar sem a regra existir.
    const cssSemComentario = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(cssSemComentario, "falta `[hidden] { display: none !important }` no style.css").toMatch(/\[hidden\]\s*\{[^}]*display:\s*none/);

    // e a regra tem que vir com !important, senão uma classe com display continua ganhando
    const regra = /\[hidden\]\s*\{([^}]*)\}/.exec(cssSemComentario)?.[1] ?? "";
    expect(regra, "a regra [hidden] sem !important perde de .painel/.login").toContain("!important");
  });

  it("todo elemento com hidden no HTML está coberto pela regra", () => {
    // Lista os ids que nascem com `hidden` e as classes deles: se alguma classe setar display e a
    // regra acima desaparecer, o teste anterior quebra. Este documenta quem depende dela.
    const comHidden = [...html.matchAll(/<div id="([^"]+)"[^>]*class="([^"]*)"[^>]*\shidden/g)].map((m) => [m[1], m[2]]);
    expect(comHidden.length, "nenhum elemento com hidden — o HTML mudou de forma").toBeGreaterThanOrEqual(2);
    for (const [id, classe] of comHidden) {
      const temDisplay = new RegExp(`\\.${classe?.split(" ")[0]}\\s*\\{[^}]*display:`).test(css);
      if (temDisplay) expect(css.replace(/\/\*[\s\S]*?\*\//g, ""), `#${id} (.${classe}) seta display e depende da regra [hidden]`).toMatch(/\[hidden\]/);
    }
  });
});
