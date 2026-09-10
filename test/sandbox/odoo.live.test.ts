// SPIKE S0.1 — vivo contra o Odoo REAL, SÓ LEITURA. Roda com: scripts/with-op-odoo.sh npm run test:odoo
// Confirma o contrato que o motor assume (campos, formatos, m2o, datas) antes de qualquer escrita.
// A escrita (S0.3: account.payment.register) NÃO roda aqui — só em duplicata, nunca em produção.
import { describe, expect, it } from "vitest";
import { OdooJson2Client } from "../../src/adapters/odoo/client.js";
import { toCents } from "../../src/core/money.js";

const key = process.env.ODOO_API_KEY;
const url = process.env.ODOO_URL ?? "";
const db = process.env.ODOO_DB || null;
const d = key && url ? describe : describe.skip;

/** Trava de segurança: mesmo em produção este arquivo não consegue escrever. Qualquer método de escrita explode ANTES de sair da máquina. */
const ESCRITA = /\/(create|write|unlink|copy|action_create_payments|action_post|button_[^/]+)$/;
const somenteLeitura: typeof fetch = async (input, init) => {
  const u = String(typeof input === "string" || input instanceof URL ? input : (input as Request).url);
  if (ESCRITA.test(new URL(u).pathname)) throw new Error(`BLOQUEADO: ${new URL(u).pathname} é escrita — o S0.1 é read-only (escrita só em duplicata, S0.3)`);
  return fetch(input as never, init as never);
};

d("Odoo real (vivo, somente leitura) — spike S0.1", () => {
  const odoo = new OdooJson2Client({ url, db, apiKey: key!, fetchImpl: somenteLeitura });
  const achados: string[] = [];
  const anota = (s: string) => { achados.push(s); console.log(`   · ${s}`); };

  it("a trava de escrita funciona (se este teste falhar, NÃO rode o resto contra produção)", async () => {
    await expect(odoo.registerPayment({ moveLineId: 1, amount: "1.00", paymentDate: "2026-01-01" })).rejects.toThrow(/BLOQUEADO|não existe/);
  });

  it("autentica no /json/2 e lê faturas de cliente postadas com o shape que o motor espera", async () => {
    const invoices = await odoo.searchInvoices({ limit: 20 });
    anota(`faturas lidas: ${invoices.length} (out_invoice, ordenadas por write_date)`);
    expect(Array.isArray(invoices)).toBe(true);
    if (invoices.length === 0) return anota("base sem faturas de cliente — o resto do spike precisa de dado real");
    for (const inv of invoices) {
      expect(inv.id).toBeGreaterThan(0);
      expect(inv.moveType).toBe("out_invoice");
      expect(inv.partnerId, `fatura ${inv.name} sem partner_id resolvido (m2o)`).toBeGreaterThan(0);
      expect(inv.writeDate, `write_date fora do ISO: ${inv.writeDate}`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(inv.amountResidual).toMatch(/^-?\d+\.\d{2}$/);
      if (inv.dueDate) expect(inv.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const posted = invoices.filter((i) => i.state === "posted");
    anota(`postadas: ${posted.length} · estados vistos: ${[...new Set(invoices.map((i) => i.state))].join(", ")}`);
    anota(`payment_state vistos: ${[...new Set(invoices.map((i) => i.paymentState))].join(", ")}`);
  });

  it("parcelas (payment_term) existem, somam o total da fatura e trazem vencimento + residual", async () => {
    const posted = (await odoo.searchInvoices({ limit: 40 })).filter((i) => i.state === "posted");
    if (posted.length === 0) return anota("sem fatura postada — pulei a checagem de parcelas");
    let comParcela = 0;
    for (const inv of posted.slice(0, 5)) {
      const linhas = await odoo.getPaymentTermLines(inv.id);
      if (linhas.length === 0) { anota(`ATENÇÃO: fatura postada ${inv.name} (id ${inv.id}) sem linha payment_term`); continue; }
      comParcela++;
      for (const l of linhas) {
        expect(l.id).toBeGreaterThan(0);
        expect(l.moveId, "move_id não resolveu para número").toBe(inv.id);
        expect(l.dateMaturity, `parcela ${l.id} sem date_maturity`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(l.amountResidual).toMatch(/^-?\d+\.\d{2}$/);
        expect(typeof l.reconciled).toBe("boolean");
      }
      const soma = linhas.reduce((s, l) => s + toCents(l.amountResidual), 0);
      anota(`${inv.name}: ${linhas.length} parcela(s) · residual fatura ${inv.amountResidual} · soma das parcelas ${(soma / 100).toFixed(2)} · vencimentos ${linhas.map((l) => l.dateMaturity).join(", ")}`);
      // O motor cobra por parcela: se a soma não bate com o residual da fatura, a premissa de 1 boleto por parcela precisa de ajuste.
      expect(Math.abs(soma - toCents(inv.amountResidual)), `soma das parcelas ≠ residual em ${inv.name}`).toBeLessThanOrEqual(1);
      const uma = await odoo.getPaymentTermLine(linhas[0]!.id);
      expect(uma?.id).toBe(linhas[0]!.id);   // leitura por id (a volta usa isso pra conferir a parcela antes da baixa)
    }
    expect(comParcela).toBeGreaterThan(0);
  });

  it("auditoria de cadastro (D7/Q8): quantos clientes com fatura postada têm CPF/CNPJ — o Asaas exige", async () => {
    const posted = (await odoo.searchInvoices({ limit: 60 })).filter((i) => i.state === "posted");
    const partnerIds = [...new Set(posted.map((i) => i.partnerId))];
    if (partnerIds.length === 0) return anota("sem parceiro para auditar");
    const semDoc: string[] = [];
    let semEmail = 0;
    for (const id of partnerIds.slice(0, 25)) {
      const p = await odoo.getPartner(id);
      if (!p) continue;
      const doc = (p.vat ?? "").replace(/\D/g, "");
      if (doc.length !== 11 && doc.length !== 14) semDoc.push(`${p.name} (id ${p.id}, vat=${p.vat ?? "vazio"})`);
      if (!p.email) semEmail++;
    }
    const auditados = Math.min(partnerIds.length, 25);
    anota(`clientes auditados: ${auditados} · SEM CPF/CNPJ válido: ${semDoc.length} · sem e-mail: ${semEmail}`);
    for (const s of semDoc.slice(0, 10)) anota(`  ⚠ sem doc: ${s}`);
    expect(auditados).toBeGreaterThan(0);   // o número de "semDoc" é o achado, não um erro: vira mutirão de higienização antes do R1
  });

  it("resumo do spike", () => {
    console.log("\n── S0.1 (leitura) ─────────────────────────────");
    for (const a of achados) console.log(`  ${a}`);
    console.log(`  base: ${url}${db ? ` · db ${db}` : ""}\n`);
    expect(achados.length).toBeGreaterThan(0);
  });
});
