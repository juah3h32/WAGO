"use client";

import { useState, useMemo } from "react";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { CopyButton } from "@/components/copy-button";
import { TokenListSkeleton } from "@/components/skeletons";
import DashboardProviders from "@/components/DashboardProviders";

interface ApiToken {
  id: string;
  name: string;
  connectionId: string | null;
  tokenPrefix: string;
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

interface Connection {
  id: string;
  name: string | null;
  status: string;
  phoneNumber: string | null;
}

interface CreatedToken {
  id: string;
  name: string;
  connectionId: string | null;
  tokenPrefix: string;
  token: string;
}

export default function TokensPage() {
  return (
    <DashboardProviders>
      <TokensPageContent />
    </DashboardProviders>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "Nunca";
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return "Hace un momento";
  const m = Math.floor(s / 60);
  if (m < 60) return `Hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h}h`;
  const d = Math.floor(h / 24);
  return `Hace ${d}d`;
}

function isRecentlyUsed(dateStr: string | null): boolean {
  if (!dateStr) return false;
  return Date.now() - new Date(dateStr).getTime() < 15 * 60 * 1000; // 15 min
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border-primary bg-bg-secondary px-5 py-4">
      <p className="text-xs font-medium text-text-tertiary uppercase tracking-wider">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-tertiary">{sub}</p>}
    </div>
  );
}

function ConnectionPill({
  connectionId,
  connections,
  size = "sm",
}: {
  connectionId: string | null;
  connections: Connection[];
  size?: "sm" | "md";
}) {
  const px = size === "md" ? "px-3 py-1" : "px-2.5 py-0.5";
  const text = size === "md" ? "text-xs" : "text-xs";

  if (!connectionId) {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full border border-border-secondary bg-bg-elevated ${px} ${text} text-text-tertiary`}>
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"/>
        </svg>
        Acceso completo
      </span>
    );
  }

  const conn = connections.find((c) => c.id === connectionId);
  const isConnected = conn?.status === "connected";
  const label = conn
    ? conn.phoneNumber
      ? `+${conn.phoneNumber}${conn.name ? ` · ${conn.name}` : ""}`
      : conn.name ?? "Sin nombre"
    : "Conexión eliminada";

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border ${isConnected ? "border-wa-green/30 bg-wa-green/5 text-wa-green" : "border-border-secondary bg-bg-elevated text-text-tertiary"} ${px} ${text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? "bg-wa-green" : "bg-text-tertiary/50"}`} />
      {label}
    </span>
  );
}

function TokenCard({
  token,
  connections,
  onRevoke,
}: {
  token: ApiToken;
  connections: Connection[];
  onRevoke: (id: string) => void;
}) {
  const recent = isRecentlyUsed(token.lastUsedAt);
  const conn = connections.find((c) => c.id === token.connectionId);
  const connActive = conn?.status === "connected";

  return (
    <div className="group relative rounded-2xl border border-border-primary bg-bg-secondary transition-all duration-150 hover:border-border-secondary hover:bg-bg-elevated hover:shadow-lg hover:shadow-black/10">
      {/* Active pulse dot */}
      {recent && (
        <span className="absolute right-4 top-4 flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-wa-green opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-wa-green" />
        </span>
      )}

      <div className="p-5">
        {/* Top row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-text-primary">{token.name}</p>
              {recent && (
                <span className="rounded-full bg-wa-green/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-wa-green">
                  Activo
                </span>
              )}
            </div>

            {/* Token prefix */}
            <div className="mt-2 flex items-center gap-2">
              <code className="rounded-lg border border-border-primary bg-bg-elevated px-3 py-1 font-mono text-xs text-text-secondary">
                {token.tokenPrefix}
              </code>
              <CopyButton text={token.tokenPrefix} />
            </div>
          </div>

          {/* Revoke button */}
          <button
            onClick={() => onRevoke(token.id)}
            className="shrink-0 rounded-xl border border-red-500/20 px-3 py-1.5 text-xs font-medium text-red-400 opacity-0 transition-all group-hover:opacity-100 hover:bg-red-500/10"
          >
            Revocar
          </button>
        </div>

        {/* Divider */}
        <div className="my-4 border-t border-border-primary" />

        {/* Bottom row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Connection */}
          <ConnectionPill connectionId={token.connectionId} connections={connections} size="md" />

          {/* Meta */}
          <div className="flex items-center gap-3 text-xs text-text-tertiary">
            <span className="flex items-center gap-1">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              {relativeTime(token.lastUsedAt)}
            </span>
            <span className="h-0.5 w-0.5 rounded-full bg-text-tertiary/40" />
            <span>
              {new Date(token.createdAt).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })}
            </span>
          </div>
        </div>

        {/* Warning if connection is gone */}
        {token.connectionId && !conn && (
          <p className="mt-3 flex items-center gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
            <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
            </svg>
            La conexión asignada fue eliminada. Este token no puede enviar mensajes.
          </p>
        )}
        {token.connectionId && conn && !connActive && (
          <p className="mt-3 flex items-center gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
            <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
            </svg>
            La conexión está desconectada ({conn.status}). Reconecta el número para usar este token.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

function TokensPageContent() {
  const { toast } = useToast();
  const { confirm } = useConfirm();

  // Auto-refresh every 10s to keep lastUsedAt and connection status current
  const { data: tokens, loading, error, mutate } = useApiData<ApiToken[]>(
    "tokens",
    () => apiFetch("/api/tokens"),
    { revalidateInterval: 10_000 }
  );
  const { data: connections } = useApiData<Connection[]>(
    "connections",
    () => apiFetch("/api/connections"),
    { revalidateInterval: 10_000 }
  );

  const list = tokens ?? [];
  const connList = connections ?? [];

  const [showModal, setShowModal] = useState(false);
  const [formName, setFormName] = useState("");
  const [formConnectionId, setFormConnectionId] = useState("");
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [newlyCreated, setNewlyCreated] = useState<CreatedToken | null>(null);

  // Stats
  const stats = useMemo(() => ({
    total: list.length,
    scoped: list.filter((t) => t.connectionId).length,
    recentlyActive: list.filter((t) => isRecentlyUsed(t.lastUsedAt)).length,
  }), [list]);

  const scopedTokens = list.filter((t) => t.connectionId);
  const globalTokens = list.filter((t) => !t.connectionId);
  const connectedConns = connList.filter((c) => c.status === "connected");

  function closeModal() {
    if (formSubmitting) return;
    setShowModal(false);
    setFormName("");
    setFormConnectionId("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim()) return;
    setFormSubmitting(true);

    const tempId = "temp-" + Math.random().toString(36).slice(2, 9);
    mutate((prev) =>
      prev
        ? [{ id: tempId, name: formName.trim(), connectionId: formConnectionId || null, tokenPrefix: "wh_...", active: true, lastUsedAt: null, createdAt: new Date().toISOString() }, ...prev]
        : prev
    );

    try {
      const body: Record<string, any> = { name: formName.trim() };
      if (formConnectionId) body.connectionId = formConnectionId;

      const created: CreatedToken = await apiFetch("/api/tokens", {
        method: "POST",
        body: JSON.stringify(body),
      });

      mutate((prev) =>
        prev
          ? prev.map((t) =>
              t.id === tempId
                ? { id: created.id, name: created.name, connectionId: created.connectionId, tokenPrefix: created.tokenPrefix, active: true, lastUsedAt: null, createdAt: new Date().toISOString() }
                : t
            )
          : prev
      );

      setNewlyCreated(created);
      closeModal();
    } catch (err) {
      mutate((prev) => (prev ? prev.filter((t) => t.id !== tempId) : prev));
      toast(err instanceof Error ? err.message : "Error al crear el token", "error");
    } finally {
      setFormSubmitting(false);
    }
  }

  async function handleRevoke(tokenId: string) {
    const ok = await confirm({
      title: "Revocar token",
      message: "Esta acción es permanente. El token dejará de funcionar de inmediato.",
      confirmLabel: "Revocar",
      destructive: true,
    });
    if (!ok) return;
    const prev = list;
    mutate(list.filter((t) => t.id !== tokenId));
    try {
      await apiFetch(`/api/tokens/${tokenId}`, { method: "DELETE" });
      toast("Token revocado", "success");
    } catch (err) {
      mutate(prev);
      toast(err instanceof Error ? err.message : "Error al revocar", "error");
    }
  }

  return (
    <div className="animate-fade-in space-y-8">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-text-primary">API Tokens</h1>
          <p className="mt-0.5 text-sm text-text-tertiary">
            Claves de acceso programático. Cada token puede limitarse a una sola conexión.
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex shrink-0 items-center gap-2 rounded-xl bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          Nuevo token
        </button>
      </div>

      {/* ── Stats (only when there are tokens) ── */}
      {list.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Total" value={stats.total} sub="tokens activos" />
          <StatCard label="Por conexión" value={stats.scoped} sub={`${stats.total - stats.scoped} con acceso completo`} />
          <StatCard label="Activos ahora" value={stats.recentlyActive} sub="últimos 15 min" />
        </div>
      )}

      {/* ── New token banner ── */}
      {newlyCreated && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
          <div className="flex items-start gap-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
              <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-400">Guardá el token ahora — no se mostrará de nuevo</p>
              <div className="mt-1 mb-2">
                <ConnectionPill connectionId={newlyCreated.connectionId} connections={connList} />
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-xl border border-border-secondary bg-bg-elevated px-4 py-2.5 font-mono text-sm text-text-primary">
                  {newlyCreated.token}
                </code>
                <CopyButton text={newlyCreated.token} />
              </div>
              <button
                onClick={() => setNewlyCreated(null)}
                className="mt-3 text-xs text-amber-400/70 hover:text-amber-400 transition-colors"
              >
                Ya lo guardé ✓
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          Error al cargar tokens: {error}
        </div>
      )}

      {loading && <TokenListSkeleton />}

      {/* ── Empty state ── */}
      {!loading && !error && list.length === 0 && !newlyCreated && (
        <div className="flex min-h-[55vh] items-center justify-center">
          <div className="flex max-w-sm flex-col items-center text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-bg-secondary border border-border-primary">
              <svg className="h-10 w-10 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
              </svg>
            </div>
            <h2 className="mt-5 text-base font-bold text-text-primary">Sin tokens todavía</h2>
            <p className="mt-2 text-sm text-text-secondary leading-relaxed">
              Crea un token para acceder a la API desde tu código, bots o integraciones externas. Puedes limitarlo a un solo número de WhatsApp.
            </p>
            <button
              onClick={() => setShowModal(true)}
              className="mt-6 w-full rounded-2xl bg-wa-green px-6 py-3 text-sm font-bold text-text-inverse hover:bg-wa-green-dark transition-all hover:shadow-xl hover:shadow-wa-green/25"
            >
              Crear primer token
            </button>
          </div>
        </div>
      )}

      {/* ── Token list ── */}
      {!loading && list.length > 0 && (
        <div className="space-y-6">
          {scopedTokens.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-text-tertiary">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"/>
                </svg>
                Por conexión &middot; {scopedTokens.length}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {scopedTokens.map((t) => (
                  <TokenCard key={t.id} token={t} connections={connList} onRevoke={handleRevoke} />
                ))}
              </div>
            </section>
          )}

          {globalTokens.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-text-tertiary">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"/>
                </svg>
                Acceso completo &middot; {globalTokens.length}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {globalTokens.map((t) => (
                  <TokenCard key={t.id} token={t} connections={connList} onRevoke={handleRevoke} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* ── Create Token Modal ── */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={closeModal}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-border-secondary bg-bg-secondary shadow-2xl animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-6 pb-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-wa-green/15">
                  <svg className="h-5 w-5 text-wa-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-base font-bold text-text-primary">Nuevo API Token</h2>
                  <p className="text-xs text-text-tertiary">Acceso programático a la API</p>
                </div>
              </div>
              <button
                onClick={closeModal}
                className="rounded-xl p-2 text-text-tertiary hover:bg-bg-elevated hover:text-text-primary transition-all"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreate} className="px-6 pb-6 space-y-4">
              {/* Name */}
              <div>
                <label htmlFor="token-name" className="mb-1.5 block text-sm font-medium text-text-secondary">
                  Nombre del token
                </label>
                <input
                  id="token-name"
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Ej. Bot ventas PABLO, Integración CRM, CI/CD"
                  disabled={formSubmitting}
                  autoFocus
                  className="block w-full rounded-xl border border-border-secondary bg-bg-input px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-2 focus:ring-wa-green/20 transition-all disabled:opacity-50"
                />
              </div>

              {/* Connection */}
              <div>
                <label htmlFor="token-conn" className="mb-1.5 block text-sm font-medium text-text-secondary">
                  Número de WhatsApp <span className="font-normal text-text-tertiary">(opcional)</span>
                </label>
                <select
                  id="token-conn"
                  value={formConnectionId}
                  onChange={(e) => setFormConnectionId(e.target.value)}
                  disabled={formSubmitting}
                  className="block w-full rounded-xl border border-border-secondary bg-bg-input px-4 py-3 text-sm text-text-primary focus:border-wa-green focus:outline-none focus:ring-2 focus:ring-wa-green/20 transition-all disabled:opacity-50"
                >
                  <option value="">Sin restricción — acceso a todas las conexiones</option>
                  {connectedConns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.phoneNumber ? `+${c.phoneNumber}` : "Sin número"}
                      {c.name ? ` · ${c.name}` : ""}
                    </option>
                  ))}
                  {connectedConns.length === 0 && (
                    <option disabled value="">— No hay conexiones activas —</option>
                  )}
                </select>
                <p className="mt-1.5 text-xs text-text-tertiary">
                  {formConnectionId
                    ? "Solo podrá acceder y enviar mensajes por ese número."
                    : "El token tendrá acceso a todos tus números de WhatsApp."}
                </p>
              </div>

              {/* Scope info box */}
              <div className={`rounded-xl border px-4 py-3 text-xs ${formConnectionId ? "border-wa-green/20 bg-wa-green/5 text-wa-green" : "border-border-primary bg-bg-elevated text-text-tertiary"}`}>
                {formConnectionId ? (
                  <div className="flex items-start gap-2">
                    <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/>
                    </svg>
                    Token con scope: solo accede a 1 conexión. Más seguro para integraciones externas.
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/>
                    </svg>
                    Token global: acceso a todas las conexiones. Usar solo en sistemas de confianza.
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={formSubmitting || !formName.trim()}
                  className="flex-1 rounded-xl bg-wa-green py-3 text-sm font-bold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {formSubmitting ? (
                    <>
                      <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                      </svg>
                      Generando…
                    </>
                  ) : "Generar token"}
                </button>
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={formSubmitting}
                  className="rounded-xl border border-border-secondary px-5 py-3 text-sm font-medium text-text-secondary hover:bg-bg-hover transition-all disabled:opacity-50"
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
