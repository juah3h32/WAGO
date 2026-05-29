#!/bin/bash
# ─────────────────────────────────────────────────────────────
# start-tunnel.sh — Expone el API local via túnel permanente
# URL fija: https://wago-api.recursomusical.com.mx
# Uso: ./start-tunnel.sh
# ─────────────────────────────────────────────────────────────

TUNNEL_URL="https://wago-api.recursomusical.com.mx"

echo "🚀 Iniciando API local + Cloudflare Tunnel permanente..."
echo "   URL fija: $TUNNEL_URL"
echo ""

# 1. Liberar el puerto si algo lo ocupa y arrancar el API
if lsof -i :3001 -sTCP:LISTEN -t > /dev/null 2>&1; then
  echo "⚠️   Puerto 3001 ocupado — matando proceso previo..."
  lsof -ti :3001 | xargs kill -9 2>/dev/null
  sleep 1
fi

echo "▶  Arrancando API en puerto 3001..."
cd /Users/govideo/Documents/WAGO
pnpm --filter @wago/api dev > /tmp/wago-api.log 2>&1 &
API_PID=$!
echo "   API PID: $API_PID"

# Esperar a que la API responda (máx 20s)
for i in $(seq 1 20); do
  sleep 1
  if curl -s http://localhost:3001/api > /dev/null 2>&1; then
    echo "✓  API lista"
    break
  fi
done

# 2. Arrancar el túnel permanente (sin URL temporal)
echo ""
echo "▶  Iniciando túnel permanente wago-api..."
cloudflared tunnel --config ~/.cloudflared/config.yml run wago-api &
TUNNEL_PID=$!

sleep 3
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  Tunnel activo:"
echo "    $TUNNEL_URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Presioná Ctrl+C para detener"

wait $TUNNEL_PID
