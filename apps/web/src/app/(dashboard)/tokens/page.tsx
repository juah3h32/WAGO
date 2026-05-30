"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { CopyButton } from "@/components/copy-button";
import { TokenListSkeleton } from "@/components/skeletons";

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

import DashboardProviders from "@/components/DashboardProviders";

export default function TokensPage() {
  return (
    <DashboardProviders>
      <TokensPageContent />
    </DashboardProviders>
  );
}

function ConnectionBadge({ connectionId, connections }: { connectionId: string | null; connections: Connection[] }) {
  if (!connectionId) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border-primary bg-bg-elevated px-2.5 py-0.5 text-xs text-text-tertiary">
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"/>
        </svg>
        Todas las conexiones
      </span>
    );
  }

  const conn = connections.find((c) => c.id === connectionId);
  const label = conn
    ? conn.phoneNumber
      ? `+${conn.phoneNumber}${conn.name ? ` · ${conn.name}` : ""}`
      : conn.name ?? "Conexión sin nombre"
    : "Conexión eliminada";

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-wa-green/30 bg-wa-green/5 px-2.5 py-0.5 text-xs text-wa-green">
      <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M2 5a2 2 0 012-2h12a2 2 0 012 2v2a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm0 8a2 2 0 012-2h12a2 2 0 012 2v2a2 2 0 01-2 2H4a2 2 0 01-2-2v-2z" clipRule="evenodd"/>
      </svg>
      {label}
    </span>
  );
}

function TokensPageContent() {
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const { data: tokens, loading, error, mutate } = useApiData<ApiToken[]>("tokens", () =>
    apiFetch("/api/tokens")
  );
  const { data: connections } = useApiData<Connection[]>("connections", () =>
    apiFetch("/api/connections")
  );

  const list = tokens ?? [];
  const connList = connections ?? [];

  const [showModal, setShowModal] = useState(false);
  const [formName, setFormName] = useState("");
  const [formConnectionId, setFormConnectionId] = useState<string>("");
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [newlyCreated, setNewlyCreated] = useState<CreatedToken | null>(null);

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
      setFormName("");
      setFormConnectionId("");
      setShowModal(false);
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
      message: "Esta acción no se puede deshacer. El token dejará de funcionar inmediatamente.",
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

  // Group tokens: scoped first, then global
  const scopedTokens = list.filter((t) => t.connectionId);
  const globalTokens = list.filter((t) => !t.connectionId);

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">API Tokens</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Crea claves de acceso por conexión. Un token con scope solo accede a su número asignado.
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="rounded-xl bg-wa-green px-5 py-2.5 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20"
        >
          <span className="flex items-center gap-2">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
            </svg>
            Nuevo token
          </span>
        </button>
      </div>

      {/* Newly created token banner */}
      {newlyCreated && (
        <div className="mt-6 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 backdrop-blur-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
              <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-amber-400">Guarda tu token ahora — no se mostrará de nuevo</p>
              <div className="mt-1 flex items-center gap-2">
                <ConnectionBadge connectionId={newlyCreated.connectionId} connections={connList} />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 break-all rounded-xl bg-bg-elevated px-4 py-2.5 text-sm text-text-primary font-mono border border-border-secondary">
                  {newlyCreated.token}
                </code>
                <CopyButton text={newlyCreated.token} />
              </div>
              <button
                onClick={() => setNewlyCreated(null)}
                className="mt-3 text-sm text-amber-400/80 hover:text-amber-400 transition-colors"
              >
                Ya lo guardé ✓
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">{error}</div>
      )}
      {loading && <TokenListSkeleton />}

      {/* Empty state */}
      {!loading && !error && list.length === 0 && !newlyCreated && (
        <div className="mt-20 flex flex-col items-center text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-border-primary bg-bg-secondary">
            <svg className="h-10 w-10 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
            </svg>
          </div>
          <p className="mt-5 text-base font-medium text-text-primary">Sin tokens todavía</p>
          <p className="mt-1 text-sm text-text-secondary">Crea uno para acceder a la API de forma programática.</p>
          <button
            onClick={() => setShowModal(true)}
            className="mt-6 rounded-xl bg-wa-green px-6 py-2.5 text-sm font-semibold text-text-inverse hover:bg-wa-green-dark transition-colors"
          >
            Crear primer token
          </button>
        </div>
      )}

      {/* Token list */}
      {list.length > 0 && (
        <div className="mt-6 space-y-6">
          {/* Scoped tokens */}
          {scopedTokens.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-text-tertiary">
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 2a4 4 0 00-4 4v1H5a1 1 0 00-.994.89l-1 9A1 1 0 004 18h12a1 1 0 00.994-1.11l-1-9A1 1 0 0015 7h-1V6a4 4 0 00-4-4zm2 5V6a2 2 0 10-4 0v1h4zm-6 3a1 1 0 112 0 1 1 0 01-2 0zm7-1a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd"/>
                </svg>
                Tokens por conexión ({scopedTokens.length})
              </h2>
              <div className="space-y-2">
                {scopedTokens.map((token) => (
                  <TokenRow key={token.id} token={token} connections={connList} onRevoke={handleRevoke} />
                ))}
              </div>
            </section>
          )}

          {/* Global tokens */}
          {globalTokens.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-text-tertiary">
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM4.332 8.027a6.012 6.012 0 011.912-2.706C6.512 5.73 6.5 5.969 6.5 6c0 1.105.895 2 2 2 .227 0 .445-.036.65-.1.208.1.4.224.578.372.228.185.434.403.613.64A6.018 6.018 0 0110 9a1 1 0 110 2 6.019 6.019 0 01-.578-.032 6.04 6.04 0 01-5.09-2.941z" clipRule="evenodd"/>
                </svg>
                Acceso completo ({globalTokens.length})
              </h2>
              <div className="space-y-2">
                {globalTokens.map((token) => (
                  <TokenRow key={token.id} token={token} connections={connList} onRevoke={handleRevoke} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Create Token Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={closeModal}
        >
          <div
            className="w-full max-w-lg rounded-3xl border border-border-secondary bg-bg-secondary shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-8 pt-8 pb-4">
              <div>
                <h2 className="text-xl font-bold text-text-primary">Nuevo API Token</h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Asigna el token a una conexión o deja en blanco para acceso total.
                </p>
              </div>
              <button
                onClick={closeModal}
                className="rounded-xl p-2 text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-all"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreate} className="px-8 pb-8 space-y-5">
              {/* Name */}
              <div>
                <label htmlFor="token-name" className="mb-2 block text-sm font-medium text-text-secondary">
                  Nombre del token
                </label>
                <input
                  id="token-name"
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Ej. Bot ventas PABLO, CI/CD, Integración X"
                  disabled={formSubmitting}
                  autoFocus
                  className="block w-full rounded-xl border border-border-secondary bg-bg-elevated px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-2 focus:ring-wa-green/20 transition-all disabled:opacity-50"
                />
              </div>

              {/* Connection selector */}
              <div>
                <label htmlFor="token-connection" className="mb-2 block text-sm font-medium text-text-secondary">
                  Conexión (opcional)
                </label>
                <select
                  id="token-connection"
                  value={formConnectionId}
                  onChange={(e) => setFormConnectionId(e.target.value)}
                  disabled={formSubmitting}
                  className="block w-full rounded-xl border border-border-secondary bg-bg-elevated px-4 py-3 text-sm text-text-primary focus:border-wa-green focus:outline-none focus:ring-2 focus:ring-wa-green/20 transition-all disabled:opacity-50"
                >
                  <option value="">— Todas las conexiones (acceso completo) —</option>
                  {connList
                    .filter((c) => c.status === "connected")
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.phoneNumber ? `+${c.phoneNumber}` : "Sin número"}
                        {c.name ? ` · ${c.name}` : ""}
                      </option>
                    ))}
                </select>
                <p className="mt-2 text-xs text-text-tertiary">
                  {formConnectionId
                    ? "Este token solo podrá acceder a la conexión seleccionada."
                    : "Sin scope: el token puede acceder a todas tus conexiones."}
                </p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={formSubmitting || !formName.trim()}
                  className="flex-1 rounded-xl bg-wa-green px-4 py-3 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20 disabled:opacity-50"
                >
                  {formSubmitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                      </svg>
                      Creando...
                    </span>
                  ) : "Generar Token"}
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

function TokenRow({
  token,
  connections,
  onRevoke,
}: {
  token: ApiToken;
  connections: Connection[];
  onRevoke: (id: string) => void;
}) {
  return (
    <div className="group flex items-center justify-between rounded-2xl border border-border-primary bg-bg-secondary px-6 py-4 transition-all hover:border-border-secondary hover:bg-bg-elevated">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-text-primary">{token.name}</p>
          <span className="font-mono text-xs text-text-tertiary bg-bg-elevated px-2 py-0.5 rounded-md border border-border-primary">
            {token.tokenPrefix}
          </span>
          <ConnectionBadge connectionId={token.connectionId} connections={connections} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-text-tertiary">
          <span>Creado {new Date(token.createdAt).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })}</span>
          <span className="w-1 h-1 rounded-full bg-text-tertiary/30" />
          <span>
            {token.lastUsedAt
              ? `Último uso ${new Date(token.lastUsedAt).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })}`
              : "Nunca usado"}
          </span>
        </div>
      </div>
      <button
        onClick={() => onRevoke(token.id)}
        className="ml-4 shrink-0 rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-medium text-red-400 opacity-0 group-hover:opacity-100 transition-all hover:bg-red-500/10"
      >
        Revocar
      </button>
    </div>
  );
}
