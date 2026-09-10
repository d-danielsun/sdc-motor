import type { Deps } from "./ports.js";
import type { CustomerMap } from "./types.js";
import { externalRefForPartner } from "./types.js";

/** CPF (11) ou CNPJ (14) — só dígitos; senão null. A validação de dígito verificador é do Asaas (ele recusa). */
export function normalizeDocument(vat: string | null | undefined): string | null {
  const d = (vat ?? "").replace(/\D/g, "");
  return d.length === 11 || d.length === 14 ? d : null;
}

/** Garante o cliente no Asaas (reaproveita por externalReference; notificações seguem a política NOTIFICATIONS_ENABLED). */
export async function ensureCustomer(deps: Deps, odooPartnerId: number): Promise<CustomerMap | null> {
  const { repo, odoo, asaas } = deps;
  const existing = await repo.customers.getByPartner(odooPartnerId);
  if (existing?.asaasCustomerId) return existing;

  const r = await repo.withLock(`partner:${odooPartnerId}`, async () => {
    const again = await repo.customers.getByPartner(odooPartnerId);
    if (again?.asaasCustomerId) return again;
    const partner = await odoo.getPartner(odooPartnerId);
    if (!partner) {
      await repo.exceptions.openOnce({ type: "customer_missing_document", refTable: "customers_map", refId: odooPartnerId, detail: { reason: "parceiro não existe (ou está arquivado) no Odoo" } });
      return null;
    }
    const cpfCnpj = normalizeDocument(partner.vat);
    const base: Omit<CustomerMap, "id"> = { odooPartnerId, asaasCustomerId: null, cpfCnpj, name: partner.name, email: partner.email, phone: partner.phone, syncStatus: "pending", lastError: null };
    if (!cpfCnpj) {
      await repo.customers.upsert({ ...base, syncStatus: "blocked_no_document", lastError: "CPF/CNPJ ausente ou inválido no Odoo" });
      await repo.exceptions.openOnce({ type: "customer_missing_document", refTable: "customers_map", refId: odooPartnerId, detail: { partnerName: partner.name, vat: partner.vat } });
      return null;
    }
    const ref = externalRefForPartner(odooPartnerId);
    const notificationsEnabled = (await repo.config.get<boolean>("NOTIFICATIONS_ENABLED")) === true;
    const found = (await asaas.findCustomerByExternalRef(ref)) ?? (await asaas.findCustomerByDocument(cpfCnpj));   // a SDC já usa este Asaas: não duplicar cliente
    const customer = found ?? (await asaas.createCustomer({ name: partner.name, cpfCnpj, email: partner.email, phone: partner.phone, externalReference: ref, notificationDisabled: !notificationsEnabled }));
    return repo.customers.upsert({ ...base, asaasCustomerId: customer.id, syncStatus: "synced" });
  });
  if (!r.ok) return (await repo.customers.getByPartner(odooPartnerId)) ?? null;   // outro processo está criando; usa o que houver
  return r.value;
}
