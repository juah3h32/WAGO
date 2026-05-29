#!/bin/bash
# ─────────────────────────────────────────────────────────────
# start-tunnel.sh — Expone el API local a internet via Cloudflare
# Uso: ./start-tunnel.sh
# ─────────────────────────────────────────────────────────────

set -e

echo "🚀 Iniciando API local + Cloudflare Tunnel..."
echo ""

# 1. Arrancar el API en background si no está corriendo
if ! lsof -i :3001 -sTCP:LISTEN -t > /dev/null 2>&1; then
  echo "▶  Arrancando API en puerto 3001..."
  pnpm --filter @wago/api dev &
  API_PID=$!
  echo "   API PID: $API_PID"
  sleep 4
else
  echo "✓  API ya está corriendo en :3001"
fi

# 2. Arrancar el tunnel y capturar la URL
echo ""
echo "▶  Iniciando Cloudflare Tunnel..."
TUNNEL_LOG=$(mktemp)
cloudflared tunnel --url http://localhost:3001 --no-autoupdate 2>&1 | tee "$TUNNEL_LOG" &
TUNNEL_PID=$!

# Esperar a que aparezca la URL
URL=""
for i in $(seq 1 20); do
  sleep 1
  URL=$(grep -o 'https://[a-z0-9\-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
  if [ -n "$URL" ]; then break; fi
done

if [ -z "$URL" ]; then
  echo "❌  No se pudo obtener la URL del tunnel"
  kill $TUNNEL_PID 2>/dev/null
  exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  Tunnel activo:"
echo "    $URL"
echo ""
echo "📋  Para actualizar Vercel con esta URL, ejecutá:"
echo "    vercel env rm PUBLIC_API_URL production --yes 2>/dev/null; echo '$URL' | vercel env add PUBLIC_API_URL production && vercel --prod --yes"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Presioná Ctrl+C para detener el tunnel"

# Mantener el script corriendo
wait $TUNNEL_PID
