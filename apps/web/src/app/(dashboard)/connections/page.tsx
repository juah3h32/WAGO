"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { StatusBadge } from "@/components/status-badge";
import { WebhookList } from "@/components/webhook-list";
import { ConnectionListSkeleton } from "@/components/skeletons";
import { CopyButton } from "@/components/copy-button";
import DashboardProviders from "@/components/DashboardProviders";

interface Connection {
  id: string; name: string | null; phoneNumber: string | null;
  status: string; createdAt: string;
}
interface QrData { value: string; mimetype: string; }
interface ApiToken {
  id: string; name: string; connectionId: string | null;
  tokenPrefix: string; active: boolean; createdAt: number;
}

// ─── WhatsApp SVG icon ────────────────────────────────────────────────────────
function WaIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  );
}

export default function ConnectionsPage() {
  return <DashboardProviders><ConnectionsPageContent /></DashboardProviders>;
}

function statFor(list: Connection[], ...statuses: string[]) {
  return list.filter((c) => statuses.includes(c.status)).length;
}

function ConnectionsPageContent() {
  const { data: connections, loading, error, mutate } = useApiData<Connection[]>(
    "connections",
    () => apiFetch("/api/connections"),
    { revalidateInterval: 4_000 }
  );
  const list = connections ?? [];
  const { toast } = useToast();
  const { confirm } = useConfirm();

  // New connection modal
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newConnId, setNewConnId] = useState<string | null>(null);
  const [newQr, setNewQr] = useState<QrData | null>(null);
  const [newModalError, setNewModalError] = useState<string | null>(null);

  // Detail modal
  const [detailConn, setDetailConn] = useState<Connection | null>(null);

  function openDetail(conn: Connection) { setDetailConn(conn); }
  function closeDetail() { setDetailConn(null); mutate(); }

  function closeNew() {
    setShowNew(false); setNewConnId(null); setNewName(""); setNewQr(null); setNewModalError(null);
  }

  // Poll QR for new connection
  useEffect(() => {
    if (!newConnId) return;
    let alive = true;
    const poll = async () => {
      try {
        const data = await apiFetch(`/api/connections/${newConnId}/qr`);
        if (!alive) return;
        if (data?.connected) { closeNew(); mutate(); }
        else if (data?.value) { setNewQr(data); setNewModalError(null); }
      } catch (err: any) {
        if (!alive) return;
        const msg = err?.message || "";
        if (!msg.includes("starting") && !msg.includes("provisioned") && !msg.includes("wait"))
          setNewModalError(msg);
      }
    };
    poll();
    const t = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [newConnId]);

  const handleCreate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true); setNewModalError(null);
    try {
      const conn = await apiFetch("/api/connections", {
        method: "POST",
        body: JSON.stringify({ name: newName || undefined }),
      });
      setNewConnId(conn.id);
      mutate();
    } catch (err) {
      setNewModalError(err instanceof Error ? err.message : "Error al crear");
    } finally { setCreating(false); }
  }, [newName, mutate]);

  const connected = statFor(list, "connected");
  const pending = statFor(list, "pending", "scan_qr");
  const failed = statFor(list, "failed");

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Conexiones</h1>
          {list.length > 0 && (
            <p className="mt-0.5 text-sm text-text-tertiary">
              {connected} conectada{connected !== 1 ? "s" : ""} · {list.length} total
            </p>
          )}
        </div>
        {list.length > 0 && (
          <button onClick={() => setShowNew(true)}
            className="flex shrink-0 items-center gap-2 rounded-xl bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20 transition-all">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
            </svg>
            Nueva
          </button>
        )}
      </div>

      {/* Stats */}
      {list.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-2xl border border-status-success-border bg-status-success-bg px-4 py-3">
            <p className="text-xs font-medium text-status-success-text/70 uppercase tracking-wider">Conectadas</p>
            <p className="mt-1 text-2xl font-bold text-status-success-text">{connected}</p>
          </div>
          <div className={`rounded-2xl border px-4 py-3 ${pending > 0 ? "border-status-warning-border bg-status-warning-bg" : "border-border-primary bg-bg-secondary"}`}>
            <p className={`text-xs font-medium uppercase tracking-wider ${pending > 0 ? "text-status-warning-text/70" : "text-text-tertiary"}`}>Pendientes</p>
            <p className={`mt-1 text-2xl font-bold ${pending > 0 ? "text-status-warning-text" : "text-text-secondary"}`}>{pending}</p>
          </div>
          <div className={`rounded-2xl border px-4 py-3 ${failed > 0 ? "border-status-error-border bg-status-error-bg" : "border-border-primary bg-bg-secondary"}`}>
            <p className={`text-xs font-medium uppercase tracking-wider ${failed > 0 ? "text-status-error-text/70" : "text-text-tertiary"}`}>Fallidas</p>
            <p className={`mt-1 text-2xl font-bold ${failed > 0 ? "text-status-error-text" : "text-text-secondary"}`}>{failed}</p>
          </div>
        </div>
      )}

      {loading && <ConnectionListSkeleton />}
      {error && (
        <div className="rounded-xl border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">
          Error al cargar: {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && list.length === 0 && (
        <div className="flex min-h-[65vh] items-center justify-center">
          <div className="flex max-w-sm flex-col items-center text-center w-full">
            <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-wa-green/10 mb-6">
              <WaIcon className="h-12 w-12 text-wa-green" />
            </div>
            <h2 className="text-2xl font-bold text-text-primary">Sin conexiones</h2>
            <p className="mt-3 text-sm text-text-secondary leading-relaxed">
              Conectá tu WhatsApp y empezá a gestionar mensajes, webhooks y automatizaciones.
            </p>
            <button onClick={() => setShowNew(true)}
              className="mt-8 w-full rounded-2xl bg-wa-green px-6 py-3.5 text-sm font-bold text-text-inverse hover:bg-wa-green-dark transition-all hover:shadow-xl hover:shadow-wa-green/25 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
              </svg>
              Crear primera conexión
            </button>
          </div>
        </div>
      )}

      {/* Connection cards grid */}
      {!loading && !error && list.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((conn) => (
            <ConnectionCard key={conn.id} conn={conn} onClick={() => openDetail(conn)} />
          ))}
        </div>
      )}

      {/* Detail modal */}
      {detailConn && (
        <ConnectionDetailModal
          conn={detailConn}
          onClose={closeDetail}
          onDeleted={() => { mutate(); closeDetail(); }}
          onUpdated={(updated) => {
            setDetailConn(updated);
            mutate();
          }}
        />
      )}

      {/* New connection modal */}
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={closeNew}>
          <div className="w-full max-w-md rounded-3xl border border-border-secondary bg-bg-secondary shadow-2xl animate-scale-in"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 pt-6 pb-2">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-wa-green/15">
                  <WaIcon className="h-5 w-5 text-wa-green" />
                </div>
                <h2 className="text-lg font-bold text-text-primary">
                  {newQr ? "Escaneá el código QR" : newConnId ? "Iniciando…" : "Nueva conexión"}
                </h2>
              </div>
              <button onClick={closeNew} className="rounded-xl p-2 text-text-tertiary hover:bg-bg-elevated hover:text-text-primary transition-all">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <div className="px-6 pb-6 pt-4">
              {!newConnId && (
                <form onSubmit={handleCreate} className="space-y-4">
                  <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                    placeholder="Nombre (opcional) — ej. Ventas, Soporte"
                    disabled={creating} autoFocus
                    className="block w-full rounded-xl border border-border-secondary bg-bg-input px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-2 focus:ring-wa-green/20 transition-all disabled:opacity-50"/>
                  {newModalError && <p className="rounded-xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text">{newModalError}</p>}
                  <button type="submit" disabled={creating}
                    className="w-full rounded-xl bg-wa-green py-3 text-sm font-bold text-text-inverse hover:bg-wa-green-dark transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                    {creating ? <><svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Creando…</> : "Crear conexión"}
                  </button>
                </form>
              )}
              {newConnId && !newQr && (
                <div className="flex flex-col items-center py-10">
                  <svg className="h-14 w-14 animate-spin text-wa-green" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                    <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  <p className="mt-4 text-sm font-semibold text-text-primary">Generando código QR…</p>
                  <p className="mt-1 text-xs text-text-tertiary">Puede tardar unos segundos</p>
                  {newModalError && <p className="mt-3 text-xs text-status-error-text">{newModalError}</p>}
                </div>
              )}
              {newQr && (
                <div className="flex flex-col items-center gap-4">
                  <div className="rounded-2xl bg-white p-3 shadow-lg">
                    <img src={`data:${newQr.mimetype};base64,${newQr.value}`} alt="QR WhatsApp" className="h-56 w-56 rounded-xl"/>
                  </div>
                  <p className="text-sm text-text-secondary text-center max-w-xs">
                    WhatsApp → <strong className="text-text-primary">Dispositivos vinculados</strong> → Vincular dispositivo → Escaneá
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Connection Card ──────────────────────────────────────────────────────────

function ConnectionCard({ conn, onClick }: { conn: Connection; onClick: () => void }) {
  const isConnected = conn.status === "connected";
  const isPending = conn.status === "scan_qr" || conn.status === "pending";
  const isFailed = conn.status === "failed";
  const label = conn.name || (conn.phoneNumber ? `+${conn.phoneNumber}` : "Sin nombre");
  const phone = conn.phoneNumber ? `+${conn.phoneNumber}` : null;

  const borderColor = isConnected
    ? "border-status-success-border/40 hover:border-status-success-border"
    : isPending ? "border-status-warning-border/40 hover:border-status-warning-border"
    : isFailed ? "border-status-error-border/40 hover:border-status-error-border"
    : "border-border-primary hover:border-border-secondary";

  return (
    <button onClick={onClick}
      className={`group relative w-full rounded-2xl border bg-bg-secondary p-5 text-left transition-all duration-200 hover:bg-bg-elevated hover:shadow-lg active:scale-[0.98] ${borderColor}`}>

      {/* Top row: icon + status dot */}
      <div className="flex items-start justify-between mb-4">
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl transition-colors
          ${isConnected ? "bg-wa-green/15" : isPending ? "bg-status-warning-bg" : isFailed ? "bg-status-error-bg" : "bg-bg-elevated"}`}>
          <WaIcon className={`h-6 w-6 ${isConnected ? "text-wa-green" : isPending ? "text-status-warning-text" : isFailed ? "text-status-error-text" : "text-text-tertiary"}`} />
        </div>

        <div className="flex items-center gap-1.5 rounded-full px-2.5 py-1 bg-bg-elevated border border-border-primary">
          <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? "bg-status-success-text animate-pulse" : isPending ? "bg-status-warning-text animate-pulse" : isFailed ? "bg-status-error-text" : "bg-text-tertiary"}`}/>
          <span className={`text-[10px] font-semibold uppercase tracking-wide
            ${isConnected ? "text-status-success-text" : isPending ? "text-status-warning-text" : isFailed ? "text-status-error-text" : "text-text-tertiary"}`}>
            {isConnected ? "Conectado" : isPending ? "Pendiente" : isFailed ? "Fallido" : conn.status}
          </span>
        </div>
      </div>

      {/* Name + phone */}
      <div className="min-w-0">
        <p className="font-bold text-text-primary truncate text-base leading-tight">{label}</p>
        {phone && conn.name && (
          <p className="mt-0.5 text-xs text-text-tertiary font-mono truncate">{phone}</p>
        )}
        {!conn.name && !conn.phoneNumber && (
          <p className="mt-0.5 text-xs text-text-tertiary font-mono truncate">{conn.id.slice(0, 16)}…</p>
        )}
      </div>

      {/* Bottom: arrow hint */}
      <div className="mt-4 flex items-center justify-between">
        <p className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium">
          {isConnected ? "Toca para gestionar" : isPending ? "Toca para ver QR" : "Toca para ver detalle"}
        </p>
        <svg className="h-4 w-4 text-text-tertiary group-hover:text-text-secondary group-hover:translate-x-0.5 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
        </svg>
      </div>
    </button>
  );
}

// ─── Connection Detail Modal ──────────────────────────────────────────────────

function ConnectionDetailModal({
  conn: initialConn, onClose, onDeleted, onUpdated,
}: {
  conn: Connection; onClose: () => void;
  onDeleted: () => void; onUpdated: (c: Connection) => void;
}) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [conn, setConn] = useState(initialConn);
  const [qr, setQr] = useState<QrData | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [wahaConnecting, setWahaConnecting] = useState(false);
  const [setupSeconds, setSetupSeconds] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState<"credentials" | "webhooks">("credentials");

  // Token state
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [newTokenValue, setNewTokenValue] = useState<string | null>(null);
  const [creatingToken, setCreatingToken] = useState(false);

  const prevStatusRef = useRef<string | null>(null);

  const isConnected = conn.status === "connected";
  const isPending = conn.status === "scan_qr" || conn.status === "pending";

  // Load tokens
  const loadTokens = useCallback(async () => {
    setTokensLoading(true);
    try {
      const all: ApiToken[] = await apiFetch(`/api/tokens`);
      setTokens((all ?? []).filter((t) => t.connectionId === conn.id));
    } catch { /* ignore */ }
    finally { setTokensLoading(false); }
  }, [conn.id]);

  useEffect(() => { loadTokens(); }, [loadTokens]);

  // Polling loop
  useEffect(() => {
    let alive = true;
    let countdown: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      let fresh: Connection;
      try { fresh = await apiFetch(`/api/connections/${conn.id}`); }
      catch { return; }
      if (!alive) return;

      const newStatus = fresh.status;
      const prevStatus = prevStatusRef.current;
      prevStatusRef.current = newStatus;
      setConn(fresh);
      onUpdated(fresh);

      if (newStatus === "connected" && prevStatus !== "connected") {
        setQr(null); setQrError(null); setSetupSeconds(0); setWahaConnecting(false);
        if (countdown) { clearInterval(countdown); countdown = null; }
        return;
      }
      if (newStatus === "connected") return;

      if (newStatus === "scan_qr" || newStatus === "pending") {
        if (!countdown) {
          setSetupSeconds(0);
          countdown = setInterval(() => setSetupSeconds(s => s + 1), 1000);
        }
        try {
          const qrData = await apiFetch(`/api/connections/${conn.id}/qr`);
          if (!alive) return;
          if (qrData?.connected) {
            setQr(null); setQrError(null); setWahaConnecting(false); setSetupSeconds(0);
            if (countdown) { clearInterval(countdown); countdown = null; }
            setConn((p) => ({ ...p, status: "connected" }));
          } else if (qrData?.connecting) {
            setQr(null); setWahaConnecting(true);
          } else if (qrData?.value) {
            setWahaConnecting(false); setQr(qrData); setQrError(null);
          }
        } catch (err) {
          if (alive) setQrError(err instanceof Error ? err.message : "Error QR");
        }
        return;
      }
      if (countdown) { clearInterval(countdown); countdown = null; setSetupSeconds(0); }
      setQr(null);
    }

    tick();
    const t = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(t); if (countdown) clearInterval(countdown); };
  }, [conn.id]);

  async function handleRestart() {
    setRestarting(true);
    prevStatusRef.current = null;
    setConn((p) => ({ ...p, status: "scan_qr" }));
    setQr(null); setWahaConnecting(false);
    try {
      await apiFetch(`/api/connections/${conn.id}/restart`, { method: "POST" });
    } catch (err) { toast(err instanceof Error ? err.message : "Error al reiniciar", "error"); }
    finally { setRestarting(false); }
  }

  async function handleReconnect() {
    const ok = await confirm({
      title: "Reconectar número",
      message: "Cierra la sesión actual y genera un nuevo QR para vincular de nuevo.",
      confirmLabel: "Reconectar", destructive: false,
    });
    if (!ok) return;
    setReconnecting(true);
    prevStatusRef.current = null;
    setConn((p) => ({ ...p, status: "scan_qr" }));
    setQr(null); setWahaConnecting(false);
    try {
      await apiFetch(`/api/connections/${conn.id}/reconnect`, { method: "POST" });
    } catch (err) { toast(err instanceof Error ? err.message : "Error al reconectar", "error"); }
    finally { setReconnecting(false); }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: "Eliminar conexión",
      message: "Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar", destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/connections/${conn.id}`, { method: "DELETE" });
      toast("Conexión eliminada", "success");
      onDeleted();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Error al eliminar", "error");
    } finally { setDeleting(false); }
  }

  async function handleCreateToken() {
    setCreatingToken(true);
    try {
      const result = await apiFetch(`/api/tokens`, {
        method: "POST",
        body: JSON.stringify({ name: `Token ${conn.name || conn.id.slice(0, 8)}`, connectionId: conn.id }),
      });
      setNewTokenValue(result.token);
      await loadTokens();
    } catch (err) { toast(err instanceof Error ? err.message : "Error al crear token", "error"); }
    finally { setCreatingToken(false); }
  }

  async function handleRevokeToken(tokenId: string) {
    const ok = await confirm({ title: "Revocar token", message: "El token dejará de funcionar.", confirmLabel: "Revocar", destructive: true });
    if (!ok) return;
    try {
      await apiFetch(`/api/tokens/${tokenId}`, { method: "DELETE" });
      setNewTokenValue(null); await loadTokens();
      toast("Token revocado", "success");
    } catch (err) { toast(err instanceof Error ? err.message : "Error", "error"); }
  }

  const label = conn.name || (conn.phoneNumber ? `+${conn.phoneNumber}` : "Conexión");
  const activeToken = tokens.find(t => t.active);

  const apiUrl = (typeof window !== "undefined" && (window as any).__API_URL__)
    || "https://api.recursomusical.com.mx";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}>
      <div className="w-full max-w-lg rounded-3xl border border-border-secondary bg-bg-secondary shadow-2xl animate-scale-in flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}>

        {/* ── Modal header ── */}
        <div className="flex items-center gap-4 px-6 pt-6 pb-4 border-b border-border-primary shrink-0">
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl
            ${isConnected ? "bg-wa-green/15" : isPending ? "bg-status-warning-bg" : "bg-bg-elevated"}`}>
            <WaIcon className={`h-6 w-6 ${isConnected ? "text-wa-green" : isPending ? "text-status-warning-text" : "text-text-tertiary"}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-text-primary truncate">{label}</p>
            {conn.phoneNumber && conn.name && (
              <p className="text-xs text-text-tertiary font-mono">+{conn.phoneNumber}</p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`h-2 w-2 rounded-full ${isConnected ? "bg-status-success-text animate-pulse" : isPending ? "bg-status-warning-text animate-pulse" : "bg-status-error-text"}`}/>
            <span className={`text-xs font-semibold ${isConnected ? "text-status-success-text" : isPending ? "text-status-warning-text" : "text-status-error-text"}`}>
              {isConnected ? "Conectado" : isPending ? "Pendiente" : conn.status}
            </span>
          </div>
          <button onClick={onClose}
            className="rounded-xl p-2 text-text-tertiary hover:bg-bg-elevated hover:text-text-primary transition-all shrink-0">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* QR section (pending) */}
          {isPending && (
            <div className="px-6 py-6 flex flex-col items-center gap-4">
              {qr && !wahaConnecting ? (
                <>
                  <div className="rounded-2xl bg-white p-3 shadow-xl">
                    <img src={`data:${qr.mimetype};base64,${qr.value}`} alt="QR" className="h-52 w-52 rounded-xl"/>
                  </div>
                  <p className="text-sm text-text-secondary text-center max-w-xs">
                    WhatsApp → <strong className="text-text-primary">Dispositivos vinculados</strong> → Vincular dispositivo → Escaneá
                  </p>
                </>
              ) : (
                <div className="flex h-[200px] w-[200px] flex-col items-center justify-center gap-3 rounded-2xl bg-bg-elevated">
                  <svg className="h-8 w-8 animate-spin text-wa-green" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                    <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  <p className="text-xs text-text-tertiary text-center px-4">
                    {wahaConnecting ? "QR escaneado — conectando…"
                      : setupSeconds > 0 ? `Iniciando… ${setupSeconds}s` : "Iniciando sesión…"}
                  </p>
                  {setupSeconds >= 15 && !wahaConnecting && (
                    <button onClick={handleRestart} disabled={restarting}
                      className="text-xs text-wa-green underline disabled:opacity-50">
                      {restarting ? "Reiniciando…" : "Reintentar"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Connected: action buttons + tabs */}
          {isConnected && (
            <div className="px-6 py-5 space-y-5">
              {/* Quick actions */}
              <div className="grid grid-cols-3 gap-2">
                <ActionBtn
                  icon={<svg className={`h-5 w-5 ${restarting ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>}
                  label={restarting ? "Reiniciando…" : "Reiniciar"}
                  onClick={handleRestart} disabled={restarting}
                  color="default"
                />
                <ActionBtn
                  icon={<svg className={`h-5 w-5 ${reconnecting ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"/></svg>}
                  label={reconnecting ? "Reconectando…" : "Reconectar"}
                  onClick={handleReconnect} disabled={reconnecting}
                  color="blue"
                />
                <ActionBtn
                  icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>}
                  label={deleting ? "Eliminando…" : "Eliminar"}
                  onClick={handleDelete} disabled={deleting}
                  color="red"
                />
              </div>

              {/* Tabs */}
              <div className="flex border-b border-border-primary gap-1">
                {(["credentials", "webhooks"] as const).map((tab) => (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 text-sm font-semibold transition-all border-b-2 -mb-px
                      ${activeTab === tab ? "border-wa-green text-wa-green" : "border-transparent text-text-tertiary hover:text-text-secondary"}`}>
                    {tab === "credentials" ? "🔑 Credenciales" : "🔗 Webhooks"}
                  </button>
                ))}
              </div>

              {activeTab === "credentials" && (
                <div className="space-y-4">
                  {/* Token */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-text-primary">Token de acceso</span>
                    {!activeToken && (
                      <button onClick={handleCreateToken} disabled={creatingToken}
                        className="flex items-center gap-1 rounded-lg bg-wa-green px-3 py-1.5 text-xs font-semibold text-text-inverse hover:bg-wa-green-dark transition-all disabled:opacity-50">
                        {creatingToken ? "Generando…" : "+ Generar token"}
                      </button>
                    )}
                  </div>
                  {tokensLoading ? (
                    <p className="text-xs text-text-tertiary">Cargando…</p>
                  ) : activeToken ? (
                    <div className="flex items-center justify-between rounded-xl border border-border-primary bg-bg-elevated px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-text-primary">{activeToken.name}</p>
                        <p className="text-xs font-mono text-text-tertiary">{activeToken.tokenPrefix}</p>
                      </div>
                      <button onClick={() => handleRevokeToken(activeToken.id)}
                        className="text-xs text-red-400 border border-red-500/20 rounded-lg px-2 py-1 hover:bg-red-500/10 transition-all">
                        Revocar
                      </button>
                    </div>
                  ) : (
                    <p className="text-sm text-text-tertiary">Sin token — generá uno para usar la API.</p>
                  )}

                  {newTokenValue && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                      <p className="text-xs font-semibold text-amber-400 mb-2">Guardá el token — no se mostrará de nuevo</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 break-all text-xs font-mono text-text-primary bg-bg-elevated rounded-lg px-3 py-2 border border-border-secondary">{newTokenValue}</code>
                        <button onClick={() => { navigator.clipboard.writeText(newTokenValue); toast("Copiado", "success"); }}
                          className="shrink-0 rounded-lg border border-border-secondary bg-bg-secondary p-2 hover:bg-bg-hover transition-all">
                          <svg className="h-4 w-4 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/>
                          </svg>
                        </button>
                      </div>
                      <button onClick={() => setNewTokenValue(null)} className="mt-2 text-xs text-amber-400/70 hover:text-amber-400">Ya lo guardé ✓</button>
                    </div>
                  )}

                  {/* ENV vars */}
                  <div>
                    <p className="mb-2 text-xs font-semibold text-text-secondary uppercase tracking-wider">Variables de entorno</p>
                    <div className="rounded-xl border border-border-secondary bg-bg-elevated">
                      <div className="relative px-4 py-3 font-mono text-xs leading-relaxed">
                        {[
                          { k: "WAGO_URL", v: apiUrl },
                          { k: "WAGO_TOKEN", v: activeToken ? activeToken.tokenPrefix.replace("...", "<token-completo>") : "<genera-un-token>" },
                          { k: "WAGO_CONNECTION_ID", v: conn.id },
                        ].map(({ k, v }) => (
                          <div key={k}>
                            <span className="text-wa-green">{k}</span>
                            <span className="text-text-tertiary">=</span>
                            <span className="text-text-secondary">{v}</span>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-border-primary px-4 py-2 flex justify-end">
                        <CopyButton text={[
                          `WAGO_URL=${apiUrl}`,
                          `WAGO_TOKEN=${activeToken ? activeToken.tokenPrefix.replace("...", "<token-completo>") : "<genera-un-token>"}`,
                          `WAGO_CONNECTION_ID=${conn.id}`,
                        ].join("\n")} />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "webhooks" && <WebhookList connectionId={conn.id} />}
            </div>
          )}

          {/* Failed state */}
          {conn.status === "failed" && (
            <div className="px-6 py-6">
              <div className="rounded-2xl border border-status-error-border bg-status-error-bg p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-status-error-text">Conexión fallida</p>
                  <p className="text-xs text-status-error-text/70 mt-0.5">Reiniciá para reconectar.</p>
                </div>
                <button onClick={handleRestart} disabled={restarting}
                  className="rounded-xl border border-status-error-border px-4 py-2 text-sm font-bold text-status-error-text hover:bg-status-error-bg/50 disabled:opacity-50">
                  {restarting ? "Reiniciando…" : "Reiniciar"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Action button helper ─────────────────────────────────────────────────────
function ActionBtn({ icon, label, onClick, disabled, color }: {
  icon: React.ReactNode; label: string; onClick: () => void;
  disabled?: boolean; color: "default" | "blue" | "red";
}) {
  const colors = {
    default: "border-border-secondary text-text-secondary hover:bg-bg-elevated hover:text-text-primary",
    blue: "border-blue-500/30 text-blue-400 hover:bg-blue-500/10",
    red: "border-status-error-border text-status-error-text hover:bg-status-error-bg",
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`flex flex-col items-center gap-1.5 rounded-2xl border px-3 py-3 text-center transition-all disabled:opacity-50 ${colors[color]}`}>
      {icon}
      <span className="text-[10px] font-semibold leading-tight">{label}</span>
    </button>
  );
}
