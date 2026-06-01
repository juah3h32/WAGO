# WAGO — Arquitectura y Referencia Técnica

> Plataforma SaaS para gestionar instancias de WhatsApp API (WAHA) en la nube, con webhooks, cola de mensajes y billing por uso.

---

## Índice

1. [¿Qué es WAGO?](#qué-es-wago)
2. [Stack tecnológico](#stack-tecnológico)
3. [Estructura del monorepo](#estructura-del-monorepo)
4. [Módulos del API](#módulos-del-api)
5. [Base de datos](#base-de-datos)
6. [Endpoints de la API](#endpoints-de-la-api)
7. [Dashboard web](#dashboard-web)
8. [Sistema de autenticación](#sistema-de-autenticación)
9. [Cola de mensajes](#cola-de-mensajes)
10. [Anti-spam y warmup](#anti-spam-y-warmup)
11. [Orquestación y despliegue](#orquestación-y-despliegue)
12. [Billing](#billing)
13. [CLI](#cli)
14. [Variables de entorno](#variables-de-entorno)
15. [Convenciones de código](#convenciones-de-código)

---

## ¿Qué es WAGO?

WAGO permite a usuarios y empresas conectar números de WhatsApp a través de la API REST de WAHA y gestionar la entrega de mensajes, webhooks y automatizaciones desde una interfaz unificada.

**Flujo principal:**
1. El usuario crea una "conexión" en el dashboard
2. WAGO aprovisiona un contenedor WAHA en la infraestructura
3. El usuario escanea el QR con su teléfono
4. WhatsApp queda vinculado — ya puede enviar/recibir mensajes via API REST
5. Los eventos de WhatsApp se entregan a webhooks configurados
6. Los mensajes se pueden encolar para envío diferido o programado

**Integraciones externas:**
- Tu proyecto usa estas variables para conectarse:
  ```
  WAGO_URL=https://api.recursomusical.com.mx
  WAGO_TOKEN=wh_xxxxxxxxxxxxxxxx
  WAGO_CONNECTION_ID=uuid-de-la-conexion
  ```

---

## Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| **Frontend** | Astro 5.7 + React 19 + Tailwind CSS 4.0 |
| **Backend** | NestJS 11 + TypeScript 5.7 (strict) |
| **Base de datos** | Turso (libSQL/SQLite) + Drizzle ORM |
| **Autenticación** | Supabase Auth (JWT + JWKS) |
| **Cola de mensajes** | BullMQ 5 + Redis 7 |
| **WhatsApp** | WAHA Core 2026.5+ (devlikeapro/waha, NOWEB engine) |
| **Billing** | Stripe (uso por horas de conexión) |
| **Contenedores** | Docker + Docker Compose (local) / Kubernetes k3s (prod) |
| **CI/CD** | GitHub Actions |
| **Despliegue web** | Vercel |
| **Despliegue API** | Docker local + Cloudflare Tunnel |
| **Package manager** | pnpm 9 + Turborepo |
| **Node** | 22.x |

---

## Estructura del monorepo

```
wago/
├── apps/
│   ├── api/                    # Servidor NestJS (puerto 3001)
│   │   └── src/
│   │       ├── auth/           # Guards, tokens, decoradores
│   │       ├── connections/    # CRUD de conexiones WhatsApp
│   │       ├── workers/        # Pool de workers WAHA
│   │       ├── waha/           # Cliente HTTP de WAHA + anti-spam
│   │       ├── webhooks/       # Config de webhooks + logs
│   │       ├── events/         # Ingestión de eventos WAHA
│   │       ├── queue/          # Procesador de cola BullMQ
│   │       ├── health/         # Cron de salud + auto-restart
│   │       ├── billing/        # Stripe + metering
│   │       └── orchestration/  # K8s / Hetzner / Mock
│   └── web/                    # Dashboard Astro/React (puerto 3000)
│       └── src/
│           ├── app/(dashboard)/ # Páginas del dashboard
│           ├── components/      # Componentes React reutilizables
│           ├── lib/             # API client, cache, Supabase
│           └── pages/           # Rutas Astro
├── packages/
│   ├── db/                     # Drizzle schema + migraciones
│   ├── shared-types/           # Tipos TypeScript compartidos
│   └── config/                 # ESLint + TSConfig compartidos
├── cli/                        # CLI Go (Cobra)
├── k8s/                        # Manifiestos Kubernetes
├── terraform/                  # IaC para cluster k3s
├── scripts/                    # Scripts de utilidad
├── docker-compose.yml          # Entorno local
└── docs/                       # Documentación
```

---

## Módulos del API

### `auth/`
- `AuthGuard`: valida JWT de Supabase o API tokens (`wh_...`)
- `@CurrentUser()`: extrae `{ sub, connectionId? }` del request
- API tokens con scope opcional a una conexión específica

### `connections/`
- CRUD completo de conexiones WhatsApp
- Flujo de QR: endpoint no-bloqueante que responde según estado de WAHA
  - WORKING → `{ connected: true }`
  - CONNECTING/PAIRING → `{ connecting: true }`
  - SCAN_QR_CODE → imagen QR en base64
- `enforceConnectionScope()`: limita tokens scoped a su conexión
- Reset warmup y reconexión forzada

### `waha/`
- Cliente HTTP para la API REST de WAHA
- `AntiSpamService`: warmup gradual (día 0: 10 msgs, día 1: 30, día 2: 80, día 3: 200, día 4+: ilimitado)
- Rate limiting por sesión (20 msgs/min) y por destinatario (8 msgs/5min)
- Simulación de presencia humana (typing, online/offline, delays variables)

### `health/`
- Cron cada 1 minuto: sincroniza estado WAHA ↔ DB
- Auto-restart de sesiones fallidas
- Compatible con WAHA 2026.5+: `GET /api/sessions` ya no lista sesiones STOPPED
- `tryAutoCreateSession`: crea si no existe, arranca si está STOPPED
- Cron cada 5 minutos: evaluación de auto-scaling

### `events/` + `webhooks/`
- `POST /api/events/waha`: recibe eventos de WAHA (interno)
- Enqueue a BullMQ `webhook-delivery`
- Entrega con firma HMAC-SHA256 (`X-Wago-Signature`)
- 5 intentos con backoff exponencial (base 5s)

### `queue/`
- Procesador BullMQ (concurrency: 2)
- Soporta: `text`, `image`, `document`, `video`, `audio`
- Reintentos: 3 por defecto (configurable)
- Mensajes programados (campo `scheduledAt`)
- Persiste en tabla `message_queue` — sobrevive reinicios

---

## Base de datos

**Motor:** Turso (libSQL/SQLite compatible) via `@libsql/client`
**ORM:** Drizzle ORM

### Tablas

| Tabla | Propósito |
|-------|-----------|
| `users` | Usuarios sincronizados desde Supabase Auth |
| `waha_workers` | Pods/contenedores WAHA asignados |
| `waha_sessions` | Conexiones WhatsApp de usuarios |
| `webhook_configs` | Endpoints webhook por conexión |
| `webhook_event_logs` | Historial de entregas de webhooks |
| `usage_records` | Métricas de uso por hora (para billing) |
| `api_tokens` | Tokens de acceso API (opcionalmente scoped) |
| `message_queue` | Cola persistente de mensajes |

### Esquema relevante: `waha_sessions`
```
id              UUID (PK)
userId          FK → users.id
workerId        FK → waha_workers.id (nullable)
sessionName     text UNIQUE — formato: u_{userId}_s_{sessionId}
phoneNumber     text — número vinculado
status          pending | scan_qr | working | failed | stopped
engine          NOWEB | WEBJS | GOWS
warmupConnectedAt  timestamp — inicio del período de warmup
warmupTotalSent    integer — mensajes enviados durante warmup
```

### Esquema relevante: `api_tokens`
```
id              UUID (PK)
userId          FK → users.id
connectionId    FK → waha_sessions.id (nullable — scope opcional)
name            text
tokenHash       text UNIQUE — SHA-256 del token completo
tokenPrefix     text — primeros 10 chars para mostrar al usuario
active          boolean
lastUsedAt      timestamp
```

### Migraciones
```bash
pnpm --filter @wago/db db:generate   # Generar SQL desde schema
pnpm --filter @wago/db db:migrate    # Aplicar migraciones a Turso
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node packages/db/scripts/migrate.cjs
```

---

## Endpoints de la API

Base URL: `https://api.recursomusical.com.mx`

**Auth:** `Authorization: Bearer <supabase-jwt>` o `Authorization: Bearer wh_<api-token>`

### Sistema
```
GET  /api                     Health check básico
```

### API Tokens
```
GET    /api/tokens             Listar tokens del usuario
POST   /api/tokens             Crear token { name, connectionId? }
DELETE /api/tokens/:id         Revocar token
```

### Conexiones WhatsApp
```
GET    /api/connections                           Listar conexiones activas
POST   /api/connections                           Crear conexión
GET    /api/connections/:id                       Detalle de conexión
PATCH  /api/connections/:id                       Actualizar nombre
DELETE /api/connections/:id                       Eliminar conexión
GET    /api/connections/:id/qr                    Código QR (non-blocking)
GET    /api/connections/:id/me                    Perfil WhatsApp vinculado
GET    /api/connections/:id/chats                 Últimos 20 chats
GET    /api/connections/:id/chats/:chatId/messages Mensajes de un chat
POST   /api/connections/:id/restart               Reinicio suave (preserva sesión)
POST   /api/connections/:id/reconnect             Reconexión forzada (nuevo QR)
POST   /api/connections/:id/reset-warmup          Resetear contador warmup
```

### Envío de mensajes
```
POST   /api/connections/:id/send            Texto
POST   /api/connections/:id/send-image      Imagen (URL o base64)
POST   /api/connections/:id/send-document   Documento/PDF (URL o base64)
POST   /api/connections/:id/send-video      Video
POST   /api/connections/:id/send-audio      Audio/voz
POST   /api/connections/:id/send-location   Ubicación (lat/lng)
POST   /api/connections/:id/send-contact    Contacto
POST   /api/connections/:id/react           Reacción emoji
POST   /api/connections/:id/mark-read       Marcar como leído
POST   /api/connections/:id/typing          Indicador de escritura
POST   /api/connections/:id/typing/stop     Detener escritura
```

### Webhooks
```
GET    /api/connections/:id/webhooks        Listar webhooks
POST   /api/connections/:id/webhooks        Crear webhook
PUT    /api/webhooks/:id                    Actualizar webhook
DELETE /api/webhooks/:id                    Eliminar webhook
GET    /api/webhooks/:id/logs               Logs de entrega (últimos 100)
POST   /api/webhooks/:id/test               Enviar evento de prueba
```

### Cola de mensajes
```
POST   /api/queue/messages          Encolar mensaje (con scheduledAt opcional)
GET    /api/queue/messages          Listar mensajes encolados
DELETE /api/queue/messages/:id      Cancelar mensaje encolado
```

### Eventos (interno)
```
POST   /api/events/waha             Ingestión de eventos WAHA (no requiere auth usuario)
```

### Billing
```
GET    /api/billing/status          Estado de billing + uso actual
GET    /api/billing/usage           Desglose de uso
POST   /api/billing/checkout        Crear sesión Stripe Checkout
POST   /api/billing/portal          Crear enlace Stripe Customer Portal
POST   /api/stripe/webhook          Receptor de webhooks Stripe
```

---

## Dashboard web

**URL:** https://recursomusical.com.mx

### Páginas

| Ruta | Descripción |
|------|-------------|
| `/dashboard/connections` | Lista de conexiones, crear nueva, estado en tiempo real |
| `/dashboard/connections/:id` | Detalle: Chat, Webhooks, acciones (Reiniciar/Reconectar/Reset warmup) |
| `/dashboard/tokens` | API Tokens con credenciales `.env`, ojo para mostrar/ocultar |
| `/dashboard/billing` | Uso y facturación |

### Características del dashboard
- Auto-refresh cada 5s (conexiones) y 10s (tokens) — no hace falta recargar
- QR polling no-bloqueante: el servidor responde inmediatamente con `connected`, `connecting` o el QR
- Chats se cargan automáticamente al conectar; reintentan cada 5s si WAHA aún sincroniza
- Botón "👁" en tokens para ver bloque `.env` con `WAGO_URL`, `WAGO_TOKEN`, `WAGO_CONNECTION_ID`

---

## Sistema de autenticación

### Supabase JWT (dashboard)
```
Authorization: Bearer eyJ...
```
- El `AuthGuard` valida firma con JWKS de Supabase
- Extrae `sub` (userId) y `email`
- Hace upsert en tabla `users` en cada request

### API Tokens (integraciones)
```
Authorization: Bearer wh_<48-hex-chars>
```
- Formato: `wh_` + 48 caracteres hex (24 bytes random)
- Almacenado como SHA-256 hash en DB
- `connectionId` opcional: limita el token a una sola conexión
- Al autenticar, inyecta `{ sub: userId, connectionId? }` en el request

### Seguridad de webhooks
- Firma HMAC-SHA256 en header `X-Wago-Signature`
- Secret único generado por webhook
- URLs deben ser públicas (rechaza localhost e IPs privadas)

---

## Cola de mensajes

### Encolar un mensaje
```http
POST /api/queue/messages
Authorization: Bearer wh_xxx

{
  "connectionId": "uuid",          // opcional — usa cualquier conexión activa si omite
  "chatId": "521234567890@c.us",
  "type": "text",
  "content": { "text": "Hola!" },
  "scheduledAt": "2026-06-02T10:00:00Z", // opcional
  "maxRetries": 3                  // opcional, default 3
}
```

### Tipos de mensaje
| type | content fields |
|------|---------------|
| `text` | `{ text }` |
| `image` | `{ url?, data?, mimetype?, caption? }` |
| `document` | `{ url?, data?, mimetype?, filename?, caption? }` |
| `video` | `{ url?, data?, mimetype?, caption? }` |
| `audio` | `{ url?, data?, mimetype? }` |

### Estados de un mensaje
```
pending → processing → sent
                    ↘ failed (después de maxRetries)
        ↘ cancelled (si se cancela manualmente)
```

---

## Anti-spam y warmup

Protege los números contra baneos de WhatsApp.

### Límites de warmup (días desde conexión)
| Día | Máximo acumulado |
|-----|-----------------|
| 0 | 10 mensajes |
| 1 | 40 mensajes |
| 2 | 120 mensajes |
| 3 | 320 mensajes |
| 4+ | Sin límite |

### Rate limits adicionales
- Máximo 20 mensajes/minuto por sesión
- Máximo 8 mensajes/5min al mismo destinatario
- Mínimo 2s entre mensajes al mismo chat

### Reset de warmup
Si cambias de número en la misma conexión, el warmup se resetea automáticamente.
También puedes hacer reset manual desde el dashboard o con `POST /api/connections/:id/reset-warmup`.

---

## Orquestación y despliegue

### Entorno local (Docker Compose)

```yaml
services:
  waha:    # Puerto 3002, WAHA Core, engine NOWEB, volumen persistente
  redis:   # Puerto 6379
  api:     # Puerto 3001, construido desde el Dockerfile local
```

```bash
docker compose up -d              # Arrancar todo
docker compose build api          # Reconstruir API
docker compose up api -d          # Actualizar solo el API
docker logs wago-api-1 -f         # Ver logs del API
docker logs wago-waha-1 -f        # Ver logs de WAHA
```

### Tunnel local → internet
- **Cloudflare Tunnel** (`com.wago.cloudflared.plist`): expone `localhost:3001` como `https://api.recursomusical.com.mx`
- Auto-inicia con macOS via LaunchAgent

### Watchdog (mantiene servicios activos)
- `com.wago.watchdog.plist`: cada 5 minutos verifica que `waha`, `redis` y `api` estén corriendo
- Si alguno cayó, lo levanta automáticamente
- Log en `/tmp/wago-watchdog.log`

### Para que el Mac no duerma
```bash
sudo pmset -c sleep 0         # No dormir cuando enchufado
sudo pmset -c disksleep 0     # No apagar discos
sudo pmset -c womp 1          # Wake on network access
```

### Producción (Kubernetes k3s)
- Cluster en Hetzner Cloud (Terraform + kube-hetzner)
- 1 nodo control-plane (CX23, Nuremberg)
- 1–10 nodos worker autoscalados (CX23) para WAHA
- Traefik ingress + cert-manager (Let's Encrypt TLS)
- CI/CD: GitHub Actions → Docker GHCR → kubectl rolling update

---

## Billing

**Modelo:** Por horas de conexión activa
- `$0.99 / conexión / mes` (por configurar)
- Cron horario registra tiempo de conexión en `usage_records`
- Otro cron reporta a Stripe Metering API

**Estado actual:** No configurado — arranca con key placeholder `sk_test_...`

---

## CLI

```bash
cd cli && go build -o wago .

wago config api-url https://api.recursomusical.com.mx
wago login email@ejemplo.com -p contraseña

wago connections list
wago connections create
wago connections qr <id> --poll
wago connections me <id>
wago connections chats <id>
wago connections restart <id>
wago connections delete <id>

wago connections e2e --no-scan   # Test completo de todos los endpoints
```

---

## Variables de entorno

### `apps/api/.env`
```env
# Base de datos
TURSO_DATABASE_URL=libsql://botgow-juanpa.aws-us-east-1.turso.io
TURSO_AUTH_TOKEN=...

# Autenticación
SUPABASE_URL=https://begktwirkeoswrsxoxph.supabase.co

# Orquestación
ORCHESTRATOR=local           # local | k8s | hetzner | mock
NODE_ENV=production

# WAHA
WAHA_HOST=waha               # o localhost si fuera del compose
WAHA_API_KEY=...
WAHA_PORT=3000
WAHA_MAX_SESSIONS=1

# URLs
PORT=3001
API_URL=https://api.recursomusical.com.mx
FRONTEND_URL=https://recursomusical.com.mx

# Redis
REDIS_URL=rediss://...@upstash.io:6379

# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

### `apps/web/.env`
```env
PUBLIC_SUPABASE_URL=https://begktwirkeoswrsxoxph.supabase.co
PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
PUBLIC_API_URL=https://api.recursomusical.com.mx
PUBLIC_POSTHOG_KEY=          # opcional
PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

---

## Convenciones de código

### Commits
```
feat:     nueva funcionalidad
fix:      corrección de bug
refactor: refactoring sin cambios funcionales
docs:     documentación
chore:    tareas de mantenimiento
test:     tests
style:    formato/estilo
```

### TypeScript
- Strict mode en todos los paquetes
- `camelCase` para variables/funciones
- `PascalCase` para tipos/clases/interfaces
- No default exports (excepto páginas Next.js/Astro)
- `.js` en imports relativos para paquetes con `Node16` module resolution

### Nombres de sesiones WAHA
```
u_{userId}_s_{sessionId}    # Aislamiento por tenant en modo multi-sesión
default                      # WAHA Core (1 sesión por pod)
```

### Seguridad
- Nunca exponer `tokenHash` — solo `tokenPrefix` al usuario
- Validar URLs de webhooks (no localhost, no IPs privadas)
- Los API keys de WAHA se almacenan cifrados en DB (`apiKeyEnc`)

---

*Generado automáticamente — última actualización: 2026-06-01*
