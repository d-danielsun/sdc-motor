// Console do motor de cobrança. Sem framework e sem build, como o salvei/site.
//
// DUAS REGRAS QUE ESTE ARQUIVO SEGUE:
// 1. A UI não inventa contrato. Cada botão chama exatamente uma rota que já existe na
//    /api/v1, mostra o `action` no sucesso e o `error` no erro, e recarrega a lista afetada.
//    Nenhuma regra de negócio mora aqui — quem decide é o motor.
// 2. Nada de innerHTML com dado do servidor. Tudo é montado com createElement e textContent,
//    porque nome de cliente e mensagem de erro vêm do Odoo e do Asaas, não da nossa cabeça.
"use strict";

const API = "/api/v1";
const $ = (id) => document.getElementById(id);

// ── estado ────────────────────────────────────────────────────────────────
let usuario = null;
let rotaPendente = null;   // para onde voltar depois do login (AC4)
const pagina = { excecoes: 0, cobrancas: 0 };
const POR_PAGINA = 25;

// ── utilidades ────────────────────────────────────────────────────────────
const el = (tag, props = {}, filhos = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "texto") n.textContent = v;
    else if (k === "hidden") n.hidden = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const f of [].concat(filhos)) if (f) n.appendChild(typeof f === "string" ? document.createTextNode(f) : f);
  return n;
};
const limpar = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

/** `href` é o único atributo em que dado do servidor não é texto: um `javascript:` vindo de
 *  um boleto viraria execução no clique. Só http(s) passa. */
const urlSegura = (v) => (typeof v === "string" && /^https?:\/\//i.test(v) ? v : null);

const dinheiro = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : String(v ?? "—");
};
/** Data civil YYYY-MM-DD: renderizada sem passar por fuso, senão vira o dia anterior. */
const data = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10).split("-").reverse().join("/") : "—");
const quando = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
};
const diasAte = (dia) => Math.round((new Date(`${dia}T12:00:00Z`) - new Date(new Date().toISOString().slice(0, 10) + "T12:00:00Z")) / 86400000);

const TIPOS = {
  customer_missing_document: ["Cliente sem CPF/CNPJ", "vermelha"],
  charge_create_failed: ["Falha ao criar boleto", "vermelha"],
  payment_unmatched: ["Pagamento sem cobrança", "laranja"],
  amount_divergent: ["Valor divergente", "laranja"],
  reversal_pending: ["Estorno pendente", "laranja"],
  queue_interrupted: ["Fila do Asaas parada", "vermelha"],
  stale_heartbeat: ["Silêncio prolongado", "laranja"],
  api_key_expiring: ["Chave do Odoo vencendo", "laranja"],
  writeoff_needed: ["Diferença a aceitar", "azul"],
  webhook_penalized: ["Webhook penalizado", "laranja"],
  integration_error: ["Erro de integração", "vermelha"],
};
const STATUS_COBRANCA = {
  pending: ["pendente", "cinza"], created: ["boleto criado", "azul"], confirmed: ["confirmada", "azul"],
  received: ["recebida", "verde"], settled: ["liquidada", "verde"], cancelled: ["cancelada", "cinza"],
  refunded: ["estornada", "laranja"], exception: ["exceção", "vermelha"],
};
const etiqueta = (texto, cor) => el("span", { class: `etq ${cor}`, texto });

// ── conversa com a API ────────────────────────────────────────────────────
class ErroApi extends Error {
  constructor(status, code, mensagem) { super(mensagem); this.status = status; this.code = code; }
}

async function api(caminho, opcoes = {}) {
  const res = await fetch(API + caminho, {
    credentials: "same-origin",
    // Toda rota que muda estado exige JSON: é o que barra formulário cross-site.
    headers: opcoes.body || opcoes.method === "DELETE" ? { "content-type": "application/json" } : {},
    ...opcoes,
  });
  if (res.status === 401) { exigirLogin(); throw new ErroApi(401, "unauthorized", "sessão expirada"); }
  const corpo = await res.json().catch(() => null);
  if (!res.ok || (corpo && corpo.ok === false)) {
    // O motor devolve { ok:false, code, error } — mostrar o `error` dele, não um genérico.
    throw new ErroApi(res.status, corpo?.code ?? "erro", corpo?.error ?? `falha ${res.status}`);
  }
  return corpo;
}

function aviso(msg, ruim = false) {
  const n = $("aviso");
  n.textContent = msg;
  n.className = ruim ? "aviso ruim" : "aviso";
  n.hidden = false;
  clearTimeout(aviso._t);
  aviso._t = setTimeout(() => { n.hidden = true; }, ruim ? 8000 : 4000);
}

// ── login ─────────────────────────────────────────────────────────────────
function exigirLogin() {
  if (!$("login").hidden) return;
  // Guarda a rota para voltar exatamente para ela depois de entrar (AC4).
  rotaPendente = location.hash || "#/excecoes";
  usuario = null;
  $("app").hidden = true;
  $("login").hidden = false;
  fecharPainel();
  $("email").focus();
}

async function entrar(ev) {
  ev.preventDefault();
  const botao = $("btn-entrar");
  const erro = $("login-erro");
  erro.hidden = true;
  botao.disabled = true;
  botao.textContent = "entrando…";
  try {
    const r = await fetch(`${API}/session`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: $("email").value, password: $("senha").value }),
    });
    const corpo = await r.json().catch(() => null);
    if (!r.ok || !corpo?.ok) {
      erro.textContent = r.status === 429
        ? "Muitas tentativas. Espere alguns minutos antes de tentar de novo."
        : (corpo?.error === "unauthorized" ? "E-mail ou senha incorretos." : corpo?.error ?? "Não consegui entrar.");
      erro.hidden = false;
      return;
    }
    $("senha").value = "";
    usuario = corpo.user;
    await abrirApp();
  } catch {
    erro.textContent = "Não consegui falar com o motor. Ele está no ar?";
    erro.hidden = false;
  } finally {
    botao.disabled = false;
    botao.textContent = "Entrar";
  }
}

async function sair() {
  try { await api("/session", { method: "DELETE" }); } catch { /* sair sempre sai */ }
  usuario = null;
  location.hash = "#/excecoes";
  exigirLogin();
}

async function abrirApp() {
  $("login").hidden = true;
  $("app").hidden = false;
  $("quem").textContent = usuario ? `${usuario.name} · ${usuario.email}` : "";
  const destino = rotaPendente || location.hash || "#/excecoes";
  rotaPendente = null;
  if (location.hash === destino) await rotear(); else location.hash = destino;
  void atualizarBadge();
}

// ── roteador ──────────────────────────────────────────────────────────────
const TELAS = {
  excecoes: { secao: "tela-excecoes", carregar: carregarExcecoes },
  cobrancas: { secao: "tela-cobrancas", carregar: carregarCobrancas },
  saude: { secao: "tela-saude", carregar: carregarSaude },
  config: { secao: "tela-config", carregar: carregarConfig },
};

async function rotear() {
  if (!usuario) return;
  const nome = (location.hash.replace(/^#\//, "").split("?")[0]) || "excecoes";
  const rota = TELAS[nome] ? nome : "excecoes";
  for (const [k, t] of Object.entries(TELAS)) $(t.secao).hidden = k !== rota;
  for (const a of document.querySelectorAll("header nav a")) {
    if (a.dataset.rota === rota) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  try { await TELAS[rota].carregar(); } catch (e) { if (e.status !== 401) aviso(e.message, true); }
}

// ── exceções ──────────────────────────────────────────────────────────────
async function carregarExcecoes() {
  const status = $("f-exc-status").value;
  const tipo = $("f-exc-tipo").value;
  const q = new URLSearchParams({ limit: String(POR_PAGINA), offset: String(pagina.excecoes * POR_PAGINA) });
  if (status) q.set("status", status);
  if (tipo) q.set("type", tipo);
  const p = await api(`/exceptions?${q}`);
  const lista = limpar($("lista-excecoes"));

  if (p.data.length === 0) {
    lista.appendChild(el("div", { class: "vazio", texto: status === "open" ? "Nenhuma exceção aberta. O motor está em dia." : "Nada aqui com esse filtro." }));
    return;
  }
  for (const e of p.data) {
    const [rotulo, cor] = TIPOS[e.type] ?? [e.type, "cinza"];
    const linha1 = el("div", { class: "linha1" }, [
      etiqueta(rotulo, cor),
      e.status !== "open" ? etiqueta(e.status === "resolved" ? "resolvida" : "ignorada", "cinza") : null,
      el("strong", { texto: e.charge ? (e.charge.invoiceName ?? `cobrança ${e.charge.id}`) : `#${e.id}` }),
      e.charge ? el("span", { class: "valor", texto: dinheiro(e.charge.amount) }) : null,
    ]);
    const meta = el("div", { class: "meta" }, [
      el("span", { texto: e.charge?.customerName ?? "sem cliente vinculado" }),
      e.charge ? el("span", { texto: `vence ${data(e.charge.dueDate)}` }) : null,
      el("span", { texto: `aberta ${quando(e.createdAt)}` }),
      e.resolvedBy ? el("span", { texto: `por ${e.resolvedBy}` }) : null,
    ]);
    lista.appendChild(el("div", { class: "item", onclick: () => abrirExcecao(e.id) }, [linha1, meta]));
  }
  lista.appendChild(paginacao("excecoes", p, carregarExcecoes));
}

function paginacao(chave, p, recarregar) {
  const total = Math.max(1, Math.ceil(p.total / p.limit));
  const atual = Math.floor(p.offset / p.limit) + 1;
  const ir = (delta) => { pagina[chave] += delta; void recarregar(); };
  return el("div", { class: "paginacao" }, [
    el("button", { class: "secundario", texto: "anterior", disabled: atual <= 1 ? "" : null, onclick: () => ir(-1) }),
    el("span", { texto: `${atual} de ${total} · ${p.total} no total` }),
    el("button", { class: "secundario", texto: "próxima", disabled: atual >= total ? "" : null, onclick: () => ir(1) }),
  ]);
}

async function abrirExcecao(id) {
  const e = await api(`/exceptions/${id}`);
  const [rotulo, cor] = TIPOS[e.type] ?? [e.type, "cinza"];
  const corpo = limpar($("painel-corpo"));
  $("painel-titulo").textContent = `Exceção #${e.id}`;

  corpo.appendChild(el("p", {}, [etiqueta(rotulo, cor), " ", etiqueta(e.status === "open" ? "aberta" : e.status === "resolved" ? "resolvida" : "ignorada", e.status === "open" ? "laranja" : "cinza")]));
  corpo.appendChild(campos([
    ["Aberta em", quando(e.createdAt)],
    e.resolvedBy ? ["Resolvida por", `${e.resolvedBy} em ${quando(e.resolvedAt)}`] : null,
    e.charge ? ["Cobrança", `${e.charge.invoiceName ?? "—"} · ${dinheiro(e.charge.amount)} · vence ${data(e.charge.dueDate)}`] : null,
    e.charge ? ["Cliente", e.charge.customerName ?? "—"] : null,
    e.refTable ? ["Referência", `${e.refTable}${e.refId ? ` #${e.refId}` : ""}`] : null,
  ]));

  // O `detail` é o que explica a exceção: renderizado legível, com o motivo em destaque.
  if (e.detail && typeof e.detail === "object") {
    const motivo = e.detail.reason ?? e.detail.error ?? e.detail.stage;
    if (motivo) corpo.appendChild(el("p", {}, [el("strong", { texto: "Motivo: " }), String(motivo)]));
    corpo.appendChild(el("h3", { texto: "Dados da exceção" }));
    corpo.appendChild(el("pre", { class: "detalhe", texto: JSON.stringify(e.detail, null, 2) }));
  }

  if (e.status === "open") {
    const acoes = el("div", { class: "acoes" });
    const acao = (texto, caminho, classe, confirmacao) => el("button", {
      class: classe ?? "",
      texto,
      onclick: async (ev) => {
        if (confirmacao && !(await confirmar(confirmacao.titulo, confirmacao.corpo, confirmacao.botao))) return;
        ev.target.disabled = true;
        try {
          const r = await api(`/exceptions/${e.id}/${caminho}`, { method: "POST" });
          aviso(`${r.action ?? caminho} · exceção #${e.id}`);
          fecharPainel();
          await rotear();
          void atualizarBadge();
        } catch (err) {
          if (err.status !== 401) { aviso(err.message, true); ev.target.disabled = false; }
        }
      },
    });
    acoes.appendChild(acao("resolver", "resolve", "principal"));
    acoes.appendChild(acao("ignorar", "ignore"));
    if (e.charge) acoes.appendChild(acao("reprocessar", "reprocess"));
    if (e.type === "writeoff_needed") {
      acoes.appendChild(acao("aceitar diferença", "accept-writeoff", "perigo", {
        titulo: "Aceitar a diferença?",
        corpo: "O motor vai registrar a baixa no Odoo com o valor recebido, assumindo a diferença como juros e multa. Isso mexe no ERP e não se desfaz por aqui.",
        botao: "aceitar e baixar",
      }));
    }
    corpo.appendChild(acoes);
  }
  $("painel").hidden = false;
}

// ── cobranças ─────────────────────────────────────────────────────────────
async function carregarCobrancas() {
  const q = new URLSearchParams({ limit: String(POR_PAGINA), offset: String(pagina.cobrancas * POR_PAGINA) });
  const status = $("f-cob-status").value;
  if (status) q.set("status", status);
  if ($("f-cob-de").value) q.set("due_from", $("f-cob-de").value);
  if ($("f-cob-ate").value) q.set("due_to", $("f-cob-ate").value);
  if ($("f-cob-q").value.trim()) q.set("q", $("f-cob-q").value.trim());
  const p = await api(`/charges?${q}`);
  const lista = limpar($("lista-cobrancas"));

  if (p.data.length === 0) {
    lista.appendChild(el("div", { class: "vazio", texto: "Nenhuma cobrança com esse filtro." }));
    return;
  }
  for (const ch of p.data) {
    const [rotulo, cor] = STATUS_COBRANCA[ch.status] ?? [ch.status, "cinza"];
    const dias = diasAte(ch.dueDate);
    const atrasada = dias < 0 && (ch.status === "created" || ch.status === "confirmed");
    const linha1 = el("div", { class: "linha1" }, [
      etiqueta(rotulo, cor),
      el("strong", { texto: ch.invoiceName ?? `cobrança ${ch.id}` }),
      el("span", { class: "valor", texto: dinheiro(ch.amount) }),
      ch.openExceptions > 0 ? etiqueta(`${ch.openExceptions} exceção${ch.openExceptions > 1 ? "s" : ""}`, "vermelha") : null,
      atrasada ? etiqueta(`${Math.abs(dias)} dia${Math.abs(dias) > 1 ? "s" : ""} em atraso`, "laranja") : null,
    ]);
    const meta = el("div", { class: "meta" }, [
      el("span", { texto: ch.customer?.name ?? "—" }),
      el("span", { texto: `vence ${data(ch.dueDate)}` }),
      ch.received ? el("span", { texto: `recebido ${dinheiro(ch.received.amountReceived)} em ${data(ch.received.paymentDate)}` }) : null,
    ]);
    const item = el("div", { class: "item", onclick: () => abrirCobranca(ch.id) }, [linha1, meta]);
    const boleto = urlSegura(ch.bankSlipUrl);
    if (boleto) {
      // O clique no boleto não pode abrir o detalhe junto.
      const link = el("a", { href: boleto, target: "_blank", rel: "noopener noreferrer", texto: "abrir boleto", onclick: (ev) => ev.stopPropagation() });
      item.appendChild(el("div", { class: "meta" }, [link]));
    }
    lista.appendChild(item);
  }
  lista.appendChild(paginacao("cobrancas", p, carregarCobrancas));
}

async function abrirCobranca(id) {
  const ch = await api(`/charges/${id}`);
  const corpo = limpar($("painel-corpo"));
  $("painel-titulo").textContent = ch.invoiceName ?? `Cobrança #${ch.id}`;
  const [rotulo, cor] = STATUS_COBRANCA[ch.status] ?? [ch.status, "cinza"];

  corpo.appendChild(el("p", {}, [etiqueta(rotulo, cor)]));
  corpo.appendChild(campos([
    ["Valor", dinheiro(ch.amount)],
    ["Vencimento", data(ch.dueDate)],
    ["Cliente", `${ch.customer?.name ?? "—"}${ch.customer?.cpfCnpj ? ` · ${ch.customer.cpfCnpj}` : ""}`],
    ["Parcela no Odoo", `fatura ${ch.odooMoveId} · linha ${ch.odooMoveLineId}`],
    ch.asaasPaymentId ? ["Cobrança no Asaas", ch.asaasPaymentId] : null,
    ch.nossoNumero ? ["Nosso número", ch.nossoNumero] : null,
    ["Criada em", quando(ch.createdAt)],
  ]));
  const boletoUrl = urlSegura(ch.bankSlipUrl);
  if (boletoUrl) corpo.appendChild(el("p", {}, [el("a", { href: boletoUrl, target: "_blank", rel: "noopener noreferrer", texto: "abrir boleto" })]));

  if (ch.reconciliations?.length) {
    corpo.appendChild(el("h3", { texto: "Conciliação" }));
    corpo.appendChild(tabela(["Recebido", "Esperado", "Diferença", "Política", "Pagamento", "Odoo"], ch.reconciliations.map((r) => [
      dinheiro(r.amountReceived), dinheiro(r.amountExpected), dinheiro(r.diff), r.diffPolicy ?? "—", data(r.paymentDate), r.odooPaymentId ? `#${r.odooPaymentId}` : "—",
    ])));
  }
  if (ch.exceptions?.length) {
    corpo.appendChild(el("h3", { texto: "Exceções" }));
    const t = tabela(["Tipo", "Status", "Aberta", "Resolvida por"], ch.exceptions.map((e) => [
      (TIPOS[e.type] ?? [e.type])[0], e.status, quando(e.createdAt), e.resolvedBy ?? "—",
    ]));
    corpo.appendChild(t);
  }
  if (ch.events?.length) {
    corpo.appendChild(el("h3", { texto: "Eventos do Asaas" }));
    corpo.appendChild(tabela(["Evento", "Processamento", "Recebido", "Tentativas", "Erro"], ch.events.map((ev) => [
      ev.eventType, ev.processStatus, quando(ev.receivedAt), String(ev.attempts), ev.error ?? "—",
    ])));
  }
  $("painel").hidden = false;
}

const campos = (pares) => el("dl", { class: "campos" }, pares.filter(Boolean).flatMap(([k, v]) => [el("dt", { texto: k }), el("dd", { texto: String(v) })]));
const tabela = (cabecalho, linhas) => el("table", {}, [
  el("thead", {}, [el("tr", {}, cabecalho.map((h) => el("th", { texto: h })))]),
  el("tbody", {}, linhas.map((l) => el("tr", {}, l.map((c) => el("td", { texto: String(c) }))))),
]);

// ── saúde ─────────────────────────────────────────────────────────────────
async function carregarSaude() {
  const [h, d] = await Promise.all([api("/health-report"), api("/dashboard")]);
  const cartoes = limpar($("cartoes"));
  const cartao = (rotulo, numero, nota, classe) => el("div", { class: `cartao ${classe ?? ""}` }, [
    el("div", { class: "rotulo", texto: rotulo }),
    el("div", { class: "numero", texto: String(numero) }),
    nota ? el("div", { class: "nota", texto: nota }) : null,
  ]);

  cartoes.appendChild(cartao("Emissão de boletos", h.idaEnabled ? "ligada" : "desligada", h.idaEnabled ? "faturas novas viram boleto" : "nada é emitido", h.idaEnabled ? "" : "atencao"));
  cartoes.appendChild(cartao("Cobranças em aberto", h.openCharges, null));
  const totalExc = Object.values(h.openExceptionsByType).reduce((a, b) => a + b, 0);
  cartoes.appendChild(cartao("Exceções abertas", totalExc, Object.entries(h.openExceptionsByType).map(([t, n]) => `${(TIPOS[t] ?? [t])[0]}: ${n}`).join(" · ") || "nenhuma", totalExc > 0 ? "atencao" : ""));
  cartoes.appendChild(cartao("Notificações ao cliente", h.notificationsEnabled ? "ligadas" : "desligadas", null));
  cartoes.appendChild(cartao("Último evento do Asaas", quando(h.lastAsaasEventAt), "chegada de pagamento"));
  cartoes.appendChild(cartao("Último evento do Odoo", quando(h.lastOdooEventAt), "fatura postada"));
  cartoes.appendChild(cartao("Fila do Asaas", h.webhook.interrupted === true ? "PARADA" : h.webhook.id ? "ok" : "sem webhook",
    h.webhook.penalizedRequestsCount !== null ? `penalizações: ${h.webhook.penalizedRequestsCount}` : "registre com o job register-asaas-webhook",
    h.webhook.interrupted === true ? "ruim" : h.webhook.id ? "" : "atencao"));
  cartoes.appendChild(cartao("Chave do Odoo", h.odooApiKeyAgeDays === null ? "—" : `${h.odooApiKeyAgeDays} dias`, h.odooApiKeyAgeDays === null ? "idade não registrada" : "vence em 90", h.odooApiKeyAgeDays !== null && h.odooApiKeyAgeDays > 75 ? "atencao" : ""));
  for (const [rotulo, j] of [["Última varredura", h.lastSync], ["Último reconcile", h.lastReconcile], ["Último watchdog", h.lastWatchdog]]) {
    cartoes.appendChild(cartao(rotulo, j ? quando(j.at) : "nunca", j ? (j.ok ? "sem erro" : "terminou com erro") : null, j && !j.ok ? "ruim" : ""));
  }

  const NOMES = { a_vencer: "A vencer", "1_7": "1 a 7 dias", "8_30": "8 a 30 dias", "31_mais": "mais de 30 dias" };
  const ag = limpar($("aging"));
  for (const b of d.aging) {
    ag.appendChild(cartao(NOMES[b.bucket] ?? b.bucket, b.count, dinheiro(b.amount), b.bucket === "31_mais" && b.count > 0 ? "ruim" : b.bucket !== "a_vencer" && b.count > 0 ? "atencao" : ""));
  }
}

// ── configuração ──────────────────────────────────────────────────────────
const AJUDA = {
  IDA_ENABLED: "Kill switch da emissão. Desligado, nenhuma fatura vira boleto — nem as antigas, quando religar, se a data de corte for depois delas.",
  TOLERANCE_BRL: "Diferença em reais que o motor aceita sem abrir exceção. Acima disso, alguém decide.",
  GO_LIVE_CUTOFF_DATE: "Régua: fatura com data anterior a esta nunca é cobrada pelo motor. Sem ela, nada é emitido.",
  JUROS_MULTA_AUTO: "Ligado, o motor baixa sozinho quando a diferença é juros e multa do próprio Asaas. Desligado, isso vira uma exceção para aceitar na mão.",
  RECONCILE_LOOKBACK_DAYS: "Quantos dias para trás o reconcile diário relê os pagamentos do Asaas.",
};

async function carregarConfig() {
  const c = await api("/config");
  const caixa = limpar($("config"));
  for (const [chave, valor] of Object.entries(c)) {
    const campo = el("div", { class: "campo" });
    const topo = el("div", { class: "topo" }, [el("code", { texto: chave })]);
    const booleano = typeof valor === "boolean";
    let ler;
    if (booleano) {
      const sel = el("select", {}, [el("option", { value: "true", texto: "ligado" }), el("option", { value: "false", texto: "desligado" })]);
      sel.value = String(valor);
      topo.appendChild(sel);
      ler = () => sel.value === "true";
    } else {
      const tipo = chave === "GO_LIVE_CUTOFF_DATE" ? "date" : chave === "RECONCILE_LOOKBACK_DAYS" ? "number" : "text";
      const inp = el("input", { type: tipo, value: valor === null ? "" : String(valor) });
      topo.appendChild(inp);
      // Dinheiro é string no motor inteiro; número inteiro é número. Respeitar isso.
      ler = () => (inp.value === "" ? null : chave === "RECONCILE_LOOKBACK_DAYS" ? Number(inp.value) : inp.value);
    }
    const salvar = el("button", { class: "principal", texto: "salvar", onclick: async (ev) => {
      const novo = ler();
      // IDA_ENABLED é o que faz dinheiro sair: confirmação em duas etapas com o texto do que acontece.
      if (chave === "IDA_ENABLED" && novo === true) {
        const ok = await confirmar("Ligar a emissão de boletos?",
          "A partir de agora, toda fatura postada no Odoo com data igual ou posterior à régua vira boleto no Asaas, e o cliente pode receber cobrança. Confira a régua antes.",
          "ligar emissão");
        if (!ok) return;
      }
      ev.target.disabled = true;
      try {
        const r = await api(`/config/${chave}`, { method: "PUT", body: JSON.stringify({ value: novo }) });
        aviso(`${r.action ?? "config"} · ${chave}`);
        await carregarConfig();
      } catch (err) {
        if (err.status !== 401) { aviso(err.message, true); ev.target.disabled = false; }
      }
    } });
    topo.appendChild(salvar);
    campo.appendChild(topo);
    if (AJUDA[chave]) campo.appendChild(el("p", { class: "ajuda", texto: AJUDA[chave] }));
    caixa.appendChild(campo);
  }
}

async function ligarNotificacoes(ev) {
  const ok = await confirmar("Ligar notificações para todos os clientes?",
    "O Asaas passa a mandar e-mail e SMS de cobrança para todos os clientes já sincronizados. Não há como desfazer em lote por aqui.",
    "ligar para todos");
  if (!ok) return;
  ev.target.disabled = true;
  try {
    const r = await api("/customers/enable-notifications", { method: "POST" });
    aviso(`${r.action ?? "notificações"} · ${JSON.stringify(r.detail ?? {})}`);
  } catch (err) {
    if (err.status !== 401) aviso(err.message, true);
  } finally {
    ev.target.disabled = false;
  }
}

// ── painéis ───────────────────────────────────────────────────────────────
const fecharPainel = () => { $("painel").hidden = true; };

function confirmar(titulo, texto, rotuloBotao) {
  return new Promise((resolve) => {
    $("confirma-titulo").textContent = titulo;
    limpar($("confirma-corpo")).appendChild(el("p", { texto }));
    const ok = $("confirma-ok");
    ok.textContent = rotuloBotao;
    const fim = (v) => {
      $("confirma").hidden = true;
      ok.onclick = null;
      $("confirma-cancelar").onclick = null;
      resolve(v);
    };
    ok.onclick = () => fim(true);
    $("confirma-cancelar").onclick = () => fim(false);
    $("confirma").hidden = false;
    $("confirma-cancelar").focus();
  });
}

async function atualizarBadge() {
  try {
    const p = await api("/exceptions?status=open&limit=1");
    const b = $("badge-excecoes");
    b.textContent = String(p.total);
    b.hidden = p.total === 0;
  } catch { /* badge é enfeite: nunca derruba a tela */ }
}

// ── início ────────────────────────────────────────────────────────────────
function popularFiltros() {
  const tipo = $("f-exc-tipo");
  for (const [k, [rotulo]] of Object.entries(TIPOS)) tipo.appendChild(el("option", { value: k, texto: rotulo }));
  const status = $("f-cob-status");
  for (const [k, [rotulo]] of Object.entries(STATUS_COBRANCA)) status.appendChild(el("option", { value: k, texto: rotulo }));
}

function ligarEventos() {
  $("login-form").addEventListener("submit", entrar);
  $("btn-sair").addEventListener("click", sair);
  $("painel-fechar").addEventListener("click", fecharPainel);
  $("painel").addEventListener("click", (e) => { if (e.target === $("painel")) fecharPainel(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharPainel(); });
  window.addEventListener("hashchange", () => { void rotear(); });
  for (const [id, chave, recarregar] of [["f-exc-status", "excecoes", carregarExcecoes], ["f-exc-tipo", "excecoes", carregarExcecoes], ["f-cob-status", "cobrancas", carregarCobrancas]]) {
    $(id).addEventListener("change", () => { pagina[chave] = 0; void recarregar().catch((e) => { if (e.status !== 401) aviso(e.message, true); }); });
  }
  for (const id of ["f-cob-de", "f-cob-ate"]) $(id).addEventListener("change", () => { pagina.cobrancas = 0; void carregarCobrancas().catch(() => {}); });
  $("f-cob-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { pagina.cobrancas = 0; void carregarCobrancas().catch(() => {}); } });
  $("f-exc-recarregar").addEventListener("click", () => { pagina.excecoes = 0; void carregarExcecoes().catch(() => {}); });
  $("f-cob-recarregar").addEventListener("click", () => { pagina.cobrancas = 0; void carregarCobrancas().catch(() => {}); });
  $("btn-notificacoes").addEventListener("click", ligarNotificacoes);
}

async function iniciar() {
  popularFiltros();
  ligarEventos();
  try {
    const r = await api("/me");
    usuario = r.user;
    await abrirApp();
  } catch {
    exigirLogin();   // 401 no /me é o caminho normal de quem ainda não entrou
  }
}

void iniciar();
