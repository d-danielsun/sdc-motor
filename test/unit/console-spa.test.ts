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
    for (const trecho of ["accept-writeoff", "IDA_ENABLED", "enable-notifications"]) {
      // O termo aparece mais de uma vez (o dicionário de ajuda, por exemplo): basta que UMA
      // das ocorrências esteja perto de uma confirmação.
      const posicoes = [...app.matchAll(new RegExp(trecho.replace(/[-/]/g, "\\$&"), "g"))].map((m) => m.index ?? 0);
      expect(posicoes.length, `${trecho} não aparece no app.js`).toBeGreaterThan(0);
      const temDialogo = posicoes.some((i) => /confirmar\(|titulo:/.test(app.slice(i, i + 900)));
      expect(temDialogo, `${trecho} sem diálogo de confirmação`).toBe(true);
    }
    // e o diálogo só resolve `true` no botão de confirmar, nunca por padrão
    expect(app).toMatch(/ok\.onclick = \(\) => fim\(true\)/);
    expect(app).toMatch(/confirma-cancelar"\)\.onclick = \(\) => fim\(false\)/);
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
