#!/bin/bash
# ─────────────────────────────────────────────────────────────
# watchdog.sh — Mantiene los contenedores WAGO corriendo
# Corre cada 5 minutos via launchd (com.wago.watchdog.plist)
# ─────────────────────────────────────────────────────────────

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
COMPOSE_FILE="/Users/govideo/Documents/WAGO/docker-compose.yml"
LOG="/tmp/wago-watchdog.log"
SERVICES="waha redis api"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

# Rotar log si supera 2 MB
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 2097152 ]; then
  mv "$LOG" "$LOG.bak"
fi

# Esperar a que Docker Desktop esté listo (hasta 60s al arrancar)
for i in $(seq 1 12); do
  if docker info > /dev/null 2>&1; then
    break
  fi
  log "Docker no disponible, esperando... ($i/12)"
  sleep 5
done

if ! docker info > /dev/null 2>&1; then
  log "ERROR: Docker no responde. Saltando esta ronda."
  exit 1
fi

# Verificar y levantar cada servicio
RESTARTED=0
for SERVICE in $SERVICES; do
  STATUS=$(docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep "^${SERVICE}$")
  if [ -z "$STATUS" ]; then
    log "Contenedor '$SERVICE' no está corriendo — levantando..."
    docker compose -f "$COMPOSE_FILE" up "$SERVICE" -d >> "$LOG" 2>&1
    RESTARTED=$((RESTARTED + 1))
  fi
done

if [ "$RESTARTED" -gt 0 ]; then
  log "Se levantaron $RESTARTED contenedor(es)"
else
  log "OK — todos los servicios corriendo"
fi
