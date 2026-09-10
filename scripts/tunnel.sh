#!/usr/bin/env bash
# Túnel público para o motor local, para o Odoo e o Asaas conseguirem entregar webhook.
#
# POR QUE ISTO EXISTE. O S0.4 precisa que o Odoo alcance o motor por HTTPS, e o
# `register-asaas-webhook` precisa de URL pública. Sem isso, os dois spikes param antes de
# começar. Quick tunnel do cloudflared: sem conta, sem domínio, sem configuração.
#
# O que o script imprime é o que vai ser COLADO: a URL da regra do Odoo já com o token, e a do
# Asaas. Montar isso à mão é onde o dedo erra.
#
# Uso: scripts/tunnel.sh [porta]        (porta default 8787)
set -euo pipefail

PORTA="${1:-${PORT:-8787}}"
LOCAL="http://localhost:${PORTA}"

# ── 1. a ferramenta existe? ──────────────────────────────────────────────────
if ! command -v cloudflared >/dev/null 2>&1; then
  cat >&2 <<'MSG'
cloudflared não está instalado — é ele que abre o túnel.

  macOS:  brew install cloudflared
  Linux:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Não precisa de conta na Cloudflare: o "quick tunnel" é anônimo e temporário.
MSG
  exit 3
fi

# ── 2. o motor está de pé? ───────────────────────────────────────────────────
# Abrir túnel para porta morta é o erro que custa mais tempo: a URL aparece, o Odoo entrega, o
# webhook morre em 502 e ninguém entende por quê.
if ! curl -fsS -m 5 "${LOCAL}/health" >/dev/null 2>&1; then
  cat >&2 <<MSG
o motor não respondeu em ${LOCAL}/health — suba ele primeiro, em outro terminal:

  npm run db:up          # se o Postgres ainda não estiver de pé
  npm run dev            # ou: npm start

Se ele está em outra porta, passe a porta: scripts/tunnel.sh <porta>
MSG
  exit 4
fi
echo "motor respondendo em ${LOCAL}/health ✓"

if [ -z "${ODOO_WEBHOOK_KEY:-}" ]; then
  echo "aviso: ODOO_WEBHOOK_KEY não está no ambiente — a URL do Odoo sai com <ODOO_WEBHOOK_KEY> no lugar do token." >&2
fi

# ── 3. abrir o túnel e capturar a URL ────────────────────────────────────────
SAIDA="$(mktemp -t tunnel-sdc)"
trap 'rm -f "$SAIDA"' EXIT
echo "abrindo o túnel…"
cloudflared tunnel --url "$LOCAL" --no-autoupdate > "$SAIDA" 2>&1 &
PID=$!
# Encerrar o túnel junto com o script: túnel órfão fica servindo o motor sem ninguém saber.
trap 'kill "$PID" 2>/dev/null || true; rm -f "$SAIDA"' EXIT INT TERM

PUBLICA=""
for _ in $(seq 1 40); do   # ~40s: o quick tunnel costuma responder em 3–10s
  PUBLICA="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$SAIDA" 2>/dev/null | head -1 || true)"
  [ -n "$PUBLICA" ] && break
  kill -0 "$PID" 2>/dev/null || break   # o cloudflared morreu: não adianta esperar
  sleep 1
done

if [ -z "$PUBLICA" ]; then
  echo "não consegui capturar a URL pública. Saída do cloudflared:" >&2
  tail -20 "$SAIDA" >&2
  exit 5
fi

KEY="${ODOO_WEBHOOK_KEY:-<ODOO_WEBHOOK_KEY>}"
cat <<MSG

  túnel no ar: ${PUBLICA}  →  ${LOCAL}

  ── cole na REGRA do Odoo (Configurações → Técnico → Automações), campo URL ──
  ${PUBLICA}/webhook-odoo?k=${KEY}

  ── use para registrar o webhook do Asaas ──
  WEBHOOK_PUBLIC_URL=${PUBLICA}/webhook-asaas ALERT_EMAIL=<seu-email> \\
    npm run job -- register-asaas-webhook

  ── conferir agora, de fora, que a entrega chega ──
  curl -sS -X POST "${PUBLICA}/webhook-odoo?k=${KEY}" \\
    -H 'content-type: application/json' -d '{"_model":"account.move","_id":1}'
  # depois: select odoo_model, odoo_id, process_status from odoo_events order by received_at desc limit 3;

  A URL muda a cada execução (quick tunnel é temporário). Se cair, rode de novo e
  atualize a regra do Odoo — é o custo de não ter domínio próprio ainda.

  Ctrl+C encerra o túnel.

MSG
wait "$PID"
