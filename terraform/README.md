# Terraform — Wago Kubernetes Cluster

Provisions a k3s cluster on Hetzner Cloud using the [kube-hetzner](https://github.com/kube-hetzner/terraform-hcloud-kube-hetzner) module (v2.15.3). All application workloads are deployed via kustomize extra-manifests.

## Prerequisites

- Terraform >= 1.5.0
- SSH key pair at `~/.ssh/wago_k8s` and `~/.ssh/wago_k8s.pub`
- Hetzner Cloud API token (read+write)
- GitHub PAT with `read:packages` scope (for GHCR image pulls)

## Setup

### 1. Create `terraform.tfvars`

This file is gitignored. Copy the template below and fill in values:

```hcl
hcloud_token         = "<hetzner-cloud-api-token>"
ssh_public_key_path  = "~/.ssh/wago_k8s.pub"
ssh_private_key_path = "~/.ssh/wago_k8s"

# GHCR image pull auth — base64 of "username:github_pat"
# Generate: echo -n "your-github-username:ghp_your_pat" | base64
ghcr_auth = "<base64-encoded-username:pat>"

# WAHA API key — shared across all WAHA pods
# Generate: openssl rand -hex 32
waha_api_key = "<random-hex-string>"

# Supabase — use the in-cluster socat proxy URL (NOT the direct Supabase URL)
database_url = "postgresql://postgres:<password>@supabase-db.default.svc.cluster.local:5432/postgres"
supabase_url = "https://<project-ref>.supabase.co"

# Public URLs
api_url      = "https://api.wago.com"
frontend_url = "https://wago.com"

# Stripe (optional — leave empty to disable billing)
# stripe_secret_key     = "sk_live_..."
# stripe_price_id       = "price_..."
# stripe_webhook_secret = "whsec_..."
```

**Important**: `database_url` must use `supabase-db.default.svc.cluster.local` (the in-cluster socat proxy), not the direct Supabase hostname. Supabase resolves to IPv6 only, which k3s pods can't reach directly. The `db-proxy.yaml` DaemonSet bridges IPv4 to IPv6.

### 2. Initialize and apply

```bash
cd terraform
terraform init
terraform plan
terraform apply
```

This creates:
- 1 control-plane node (cx23, Nuremberg)
- 1-10 autoscaled worker nodes (cx23, for WAHA pods)
- Hetzner Load Balancer for ingress
- k3s with Traefik, cert-manager, and metrics-server
- All application manifests via kustomize

### 3. Get kubeconfig

After apply, the kubeconfig is written to `terraform/wago_kubeconfig.yaml` (gitignored):

```bash
export KUBECONFIG=$(pwd)/wago_kubeconfig.yaml
kubectl get pods -n default
```

## Architecture

```
extra-manifests/
├── ghcr-secret.yaml.tpl       # GHCR image pull credentials
├── waha-secret.yaml.tpl        # WAHA API key + DB URL for session persistence
├── wago-api-secret.yaml.tpl # All API env vars (DB, Supabase, Stripe, etc.)
├── rbac.yaml.tpl               # ServiceAccount + RBAC for API k8s access
├── redis.yaml.tpl              # Redis deployment + service
├── db-proxy.yaml.tpl           # socat DaemonSet bridging IPv4→IPv6 for Supabase
├── waha-service.yaml.tpl       # Headless service for WAHA StatefulSet
├── waha-statefulset.yaml.tpl   # WAHA pods (1 session per pod, WAHA Core)
├── api-deployment.yaml.tpl     # NestJS API deployment
├── api-service.yaml.tpl        # API NodePort service
├── api-ingress.yaml.tpl        # Traefik Ingress + Let's Encrypt ClusterIssuer
└── kustomization.yaml.tpl      # Kustomize resource list
```

### DB connectivity

Supabase Postgres has only AAAA (IPv6) DNS records. k3s pod network doesn't route IPv6 outbound. The `db-proxy.yaml` deploys a socat DaemonSet with `hostNetwork: true` that bridges:

```
Pod (IPv4) → supabase-db:5432 (ClusterIP) → socat (host network, IPv6) → Supabase
```

### TLS

cert-manager with Let's Encrypt HTTP-01 solver via Traefik. The `api-ingress.yaml` creates both the `ClusterIssuer` and the `Ingress` resource for `api.wago.com`.

## Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `hcloud_token` | Yes | — | Hetzner Cloud API token |
| `ssh_public_key_path` | No | `~/.ssh/wago_k8s.pub` | SSH public key path |
| `ssh_private_key_path` | No | `~/.ssh/wago_k8s` | SSH private key path |
| `ghcr_auth` | Yes | — | Base64 `username:PAT` for ghcr.io |
| `waha_api_key` | Yes | — | WAHA API key (shared across pods) |
| `database_url` | Yes | — | Postgres URL (use in-cluster proxy) |
| `supabase_url` | Yes | — | Supabase project URL (JWT verification) |
| `stripe_secret_key` | No | `""` | Stripe secret key |
| `stripe_price_id` | No | `""` | Stripe price ID |
| `stripe_webhook_secret` | No | `""` | Stripe webhook secret |
| `api_url` | No | `https://api.wago.com` | Public API URL |
| `frontend_url` | No | `https://wago.com` | Public frontend URL |
| `api_image` | No | `ghcr.io/juah3h32/wago/api:latest` | API container image |

## CI/CD

GitHub Actions (`.github/workflows/deploy-api.yml`) handles deployments on push to `main`:

1. **Build**: Docker image pushed to GHCR with `:latest` and `:sha` tags
2. **Migrate**: Runs Drizzle migrations in-cluster via `kubectl run` pod (uses socat proxy for DB access)
3. **Deploy**: `kubectl set image` updates the API deployment, waits for rollout

Required GitHub Actions secrets:
- `DEPLOY_KUBECONFIG`: base64-encoded kubeconfig (`cat wago_kubeconfig.yaml | base64`)
- No `DATABASE_URL` secret needed — migrations read it from the in-cluster `wago-api-secret`

## Known Issues

- **Traefik v28+** breaks schema — pinned to v27.0.2
- **GHCR packages are private by default** even for public repos — `ghcr-secret` is required
- **WAHA Core** (free edition) supports 1 session per pod, session name must be `default`
- **kured v1.16.0** pinned to avoid GitHub API rate-limit failures during install
- After initial cluster creation, DNS for `api.wago.com` must point to the Hetzner LB IP
