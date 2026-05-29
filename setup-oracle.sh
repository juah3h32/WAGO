#!/bin/bash
set -e

# ─── Colors ────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
info() { echo -e "${YELLOW}→ $1${NC}"; }
err()  { echo -e "${RED}✗ $1${NC}"; exit 1; }

echo ""
echo "╔══════════════════════════════════════╗"
echo "║     WAGO — Setup Oracle Cloud        ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ─── 1. Detectar IP pública ────────────────────────────────────────────────
info "Detectando IP pública del servidor..."
PUBLIC_IP=$(curl -s ifconfig.me || curl -s icanhazip.com || curl -s api.ipify.org)
[ -z "$PUBLIC_IP" ] && err "No se pudo detectar la IP pública"
ok "IP pública: $PUBLIC_IP"

# ─── 2. Instalar Docker ────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  info "Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  ok "Docker instalado"
else
  ok "Docker ya instalado ($(docker --version | cut -d' ' -f3 | tr -d ','))"
fi

# ─── 3. Instalar docker compose plugin si falta ────────────────────────────
if ! docker compose version &>/dev/null; then
  info "Instalando Docker Compose plugin..."
  sudo apt-get install -y docker-compose-plugin
fi
ok "Docker Compose listo"

# ─── 4. Abrir puertos en el firewall del OS ────────────────────────────────
info "Abriendo puertos 3001 (API) y 80 (HTTP)..."
sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT -p tcp --dport 80   -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || true
# Guardar reglas para que persistan tras reinicio
if command -v netfilter-persistent &>/dev/null; then
  sudo netfilter-persistent save
else
  sudo apt-get install -y iptables-persistent netfilter-persistent 2>/dev/null || true
  sudo netfilter-persistent save 2>/dev/null || true
fi
ok "Puertos abiertos"

# ─── 5. Clonar o actualizar el repositorio ─────────────────────────────────
REPO_DIR="$HOME/wago"
if [ -d "$REPO_DIR/.git" ]; then
  info "Actualizando repositorio existente..."
  git -C "$REPO_DIR" pull
else
  info "Clonando repositorio..."
  git clone https://github.com/juah3h32/WAGO.git "$REPO_DIR"
fi
ok "Código listo en $REPO_DIR"

# ─── 6. Crear archivo .env ─────────────────────────────────────────────────
info "Creando .env con IP $PUBLIC_IP..."
cat > "$REPO_DIR/.env" << EOF
# Base de datos
TURSO_DATABASE_URL=libsql://botgow-juanpa.aws-us-east-1.turso.io
TURSO_AUTH_TOKEN=eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzg1MTgyMzYsImlkIjoiMDE5ZTE3ZjItOGIwMS03ZTI2LWJjM2EtMWI4MzkzMDdkYTQyIiwicmlkIjoiNjg2MDhlZDEtY2FkOC00YjVlLWJkNDEtYjUxNGFjNDMxMmEyIn0.6UqwsuLchAhsW95NWEyuEfw1mXfRZwcDTWC8BqhKmvaIeDEh-M2nVuk1MdXJeZNvJ9oCiauOBQyegKVzffGXBA

# Autenticación
SUPABASE_URL=https://begktwirkeoswrsxoxph.supabase.co

# WAHA
WAHA_API_KEY=devkey

# URLs — apunta a este servidor
API_URL=http://${PUBLIC_IP}:3001
FRONTEND_URL=https://wago.com
EOF
ok ".env creado"

# ─── 7. Levantar todo con Docker Compose ───────────────────────────────────
info "Construyendo y levantando servicios (puede tardar ~5 min la primera vez)..."
cd "$REPO_DIR"
sudo docker compose up -d --build

# ─── 8. Verificar que todo está corriendo ──────────────────────────────────
echo ""
info "Verificando servicios..."
sleep 8

sudo docker compose ps

# Probar health del API
API_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3001/api" 2>/dev/null || echo "000")
if [ "$API_HEALTH" = "200" ]; then
  ok "API respondiendo en http://${PUBLIC_IP}:3001/api"
else
  echo -e "${YELLOW}⚠ API aún iniciando (código: $API_HEALTH) — espera 30 seg y prueba:${NC}"
  echo "  curl http://localhost:3001/api"
fi

# ─── 9. Resumen final ──────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✅  WAGO instalado y corriendo                              ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  API:   http://%-46s║\n" "${PUBLIC_IP}:3001/api"
printf "║  WAHA:  http://%-46s║\n" "${PUBLIC_IP}:3000"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Siguiente paso:                                             ║"
echo "║  Agrega esta variable en Vercel (dashboard → Settings →     ║"
printf "║  Environment Variables):                                     ║"
echo ""
printf "║    NEXT_PUBLIC_API_URL = http://%-29s║\n" "${PUBLIC_IP}:3001"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Comandos útiles:"
echo "  docker compose logs api -f     # Ver logs de la API"
echo "  docker compose logs waha -f    # Ver logs de WAHA"
echo "  docker compose restart api     # Reiniciar la API"
echo "  docker compose ps              # Ver estado de servicios"
echo ""
