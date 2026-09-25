// SPIKE S0.1 — vivo contra o Odoo REAL, SÓ LEITURA. Roda com: scripts/with-op-odoo.sh npm run test:odoo
// Confirma o contrato que o motor assume (campos, formatos, m2o, datas) antes de qualquer escrita.
// A escrita (S0.3: account.payment.register) NÃO roda aqui — só em duplicata, nunca em produção.
import { describe, expect, it } from "vitest";
import { OdooJson2Client } from "../../src/adapters/odoo/client.js";
import { toCents } from "../../src/core/money.js";

const key = process.env.ODOO_API_KEY;
const url = process.env.ODOO_URL ?? "";
const db = process.env.ODOO_DB || null;

/** Trava de segurança: mesmo em produção este arquivo não consegue escrever. Qualquer método de escrita explode ANTES de sair da máquina. */
const somenteLeitura: typeof fetch = async (input, init) => {
  const u = String(typeof input === "string" || input instanceof URL ? input : (input as Request).url);
  if (!new URL(u).pathname.endsWith("/search_read")) throw new Error(`BLOQUEADO: S0.1 só permite search_read (escrita só em duplicata, S0.3)`);
  return fetch(input as never, init as never);
};

if (!key || !url || !db) describe("Odoo real (vivo, somente leitura) — spike S0.1", () => {
  it("exige API key, URL e banco explícitos; não aceita teste pulado como prova", () => {
    throw new Error("S0.1 não executado: defina ODOO_API_KEY, ODOO_URL e ODOO_DB (use scripts/with-op-odoo.sh)");
  });
});
else describe("Odoo real (vivo, somente leitura) — spike S0.1", () => {
  const odoo = new OdooJson2Client({ url, db, apiKey: key!, fetchImpl: somenteLeitura });
  const achados: string[] = [];
  const anota = (s: string) => { achados.push(s); console.log(`   · ${s}`); };
  const postedInvoices = async (limit: number) => {
    const ids = await odoo.call<Array<{ id: number }>>("account.move", "search_read", {
      domain: [["move_type", "=", "out_invoice"], ["state", "=", "posted"]], fields: ["id"], order: "write_date desc", limit,
    });
    expect(Array.isArray(ids), "busca de faturas postadas não retornou lista").toBe(true);
    const invoices = await Promise.all(ids.map((row) => odoo.getInvoice(row.id)));
    return invoices.filter((inv): inv is NonNullable<typeof inv> => inv !== null);
  };

  it("a trava de escrita funciona (se este teste falhar, NÃO rode o resto contra produção)", async () => {
    await expect(somenteLeitura(`${url}/json/2/account.payment.register/create`, { method: "POST" })).rejects.toThrow(/BLOQUEADO/);
  });

  it("autentica no /json/2 e lê faturas de cliente postadas com o shape que o motor espera", async () => {
    const invoices = await odoo.searchInvoices({ limit: 20 });
    anota(`faturas lidas: ${invoices.length} (out_invoice, ordenadas por write_date)`);
    expect(Array.isArray(invoices)).toBe(true);
    expect(invoices.length, "S0.1 precisa ler ao menos uma fatura de cliente").toBeGreaterThan(0);
    for (const inv of invoices) {
      expect(inv.id).toBeGreaterThan(0);
      expect(inv.moveType).toBe("out_invoice");
      expect(inv.partnerId, "partner_id não resolvido (m2o)").toBeGreaterThan(0);
      expect(inv.writeDate, "write_date fora do ISO").toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(inv.amountResidual).toMatch(/^-?\d+\.\d{2}$/);
      if (inv.dueDate) expect(inv.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const posted = await postedInvoices(5);
    anota(`postadas: ${posted.length} · estados vistos: ${[...new Set(invoices.map((i) => i.state))].join(", ")}`);
    anota(`payment_state vistos: ${[...new Set(invoices.map((i) => i.paymentState))].join(", ")}`);
    expect(posted.length, "S0.1 precisa de ao menos uma fatura postada").toBeGreaterThan(0);
  });

  it("parcelas (payment_term) existem, somam o total da fatura e trazem vencimento + residual", async () => {
    const posted = await postedInvoices(5);
    expect(posted.length, "S0.1 precisa de fatura postada com payment_term").toBeGreaterThan(0);
    let comParcela = 0;
    for (const inv of posted.slice(0, 5)) {
      const linhas = await odoo.getPaymentTermLines(inv.id);
      if (linhas.length === 0) { anota("ATENÇÃO: fatura postada sem linha payment_term"); continue; }
      comParcela++;
      for (const l of linhas) {
        expect(l.id).toBeGreaterThan(0);
        expect(l.moveId, "move_id não resolveu para número").toBe(inv.id);
        expect(l.dateMaturity, "parcela sem date_maturity").toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(l.amountResidual).toMatch(/^-?\d+\.\d{2}$/);
        expect(typeof l.reconciled).toBe("boolean");
      }
      const soma = linhas.reduce((s, l) => s + toCents(l.amountResidual), 0);
      anota(`parcelas: ${linhas.length} · residual fatura ${inv.amountResidual} · soma ${(soma / 100).toFixed(2)}`);
      // O motor cobra por parcela: se a soma não bate com o residual da fatura, a premissa de 1 boleto por parcela precisa de ajuste.
      expect(Math.abs(soma - toCents(inv.amountResidual)), "soma das parcelas difere do residual da fatura").toBeLessThanOrEqual(1);
      const uma = await odoo.getPaymentTermLine(linhas[0]!.id);
      expect(uma?.id).toBe(linhas[0]!.id);   // leitura por id (a volta usa isso pra conferir a parcela antes da baixa)
    }
    expect(comParcela).toBeGreaterThan(0);
  });

  it("auditoria de cadastro (D7/Q8): quantos clientes com fatura postada têm CPF/CNPJ — o Asaas exige", async () => {
    const posted = await postedInvoices(25);
    const partnerIds = [...new Set(posted.map((i) => i.partnerId))];
    if (partnerIds.length === 0) return anota("sem parceiro para auditar");
    let semDoc = 0;
    let semEmail = 0;
    for (const id of partnerIds.slice(0, 25)) {
      const p = await odoo.getPartner(id);
      if (!p) continue;
      const doc = (p.vat ?? "").replace(/\D/g, "");
      if (doc.length !== 11 && doc.length !== 14) semDoc++;
      if (!p.email) semEmail++;
    }
    const auditados = Math.min(partnerIds.length, 25);
    anota(`clientes auditados: ${auditados} · SEM CPF/CNPJ válido: ${semDoc} · sem e-mail: ${semEmail}`);
    expect(auditados).toBeGreaterThan(0);   // o número de "semDoc" é o achado, não um erro: vira mutirão de higienização antes do R1
  });

  it("resumo do spike", () => {
    console.log("\n── S0.1 (leitura) ─────────────────────────────");
    for (const a of achados) console.log(`  ${a}`);
    console.log("  ambiente Odoo: URL e banco omitidos do log\n");
    expect(achados.length).toBeGreaterThan(0);
  });
});
