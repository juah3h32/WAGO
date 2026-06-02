"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter, Link } from "@/lib/next-shim";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { StatusBadge } from "@/components/status-badge";
import { WebhookList } from "@/components/webhook-list";
import { CopyButton } from "@/components/copy-button";
import { ConnectionDetailSkeleton } from "@/components/skeletons";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import DashboardProviders from "@/components/DashboardProviders";

interface Connection {
  id: string; name: string | null; status: string;
  me: { id: string; pushName?: string } | null;
}
interface QrData { value: string; mimetype: string; }
interface WaProfile { id: string; pushName: string; }
interface ApiToken {
  id: string; name: string; connectionId: string | null;
  tokenPrefix: string; active: boolean;
  lastUsedAt: number | null; createdAt: number;
}

export default function ConnectionDetailPage() {
  return <DashboardProviders><ConnectionDetailPageContent /></DashboardProviders>;
}

function ConnectionDetailPageContent() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const id = params.id;

  const { data: connection, loading, error, mutate: mutateConn } = useApiData<Connection>(
    `connection-${id}`, () => apiFetch(`/api/connections/${id}`)
  );
  const [qr, setQr] = useState<QrData | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [resettingWarmup, setResettingWarmup] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [setupSeconds, setSetupSeconds] = useState(0);
  const [wahaConnecting, setWahaConnecting] = useState(false);
  const [profile, setProfile] = useState<WaProfile | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [customName, setCustomName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<"credentials" | "webhooks">("credentials");

  // Token state
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [newTokenValue, setNewTokenValue] = useState<string | null>(null);
  const [creatingToken, setCreatingToken] = useState(false);

  const prevStatusRef = useRef<string | null>(null);
  const mutateConnRef = useRef(mutateConn);
  mutateConnRef.current = mutateConn;

  // ─── Load tokens ────────────────────────────────────────────────────────────
  const loadTokens = useCallback(async () => {
    setTokensLoading(true);
    try {
      const all: ApiToken[] = await apiFetch(`/api/tokens`);
      setTokens((all ?? []).filter((t) => t.connectionId === id));
    } catch { /* ignore */ }
    finally { setTokensLoading(false); }
  }, [id]);

  useEffect(() => { loadTokens(); }, [loadTokens]);

  // ─── Load profile when connected ────────────────────────────────────────────
  const loadProfile = useCallback(async (cancelled: { v: boolean }) => {
    try {
      const me = await apiFetch(`/api/connections/${id}/me`).catch(() => null);
      if (!cancelled.v && me) setProfile(me);
    } catch { /* ignore */ }
  }, [id]);

  // ─── Single master polling loop ─────────────────────────────────────────────
  useEffect(() => {
    const cancelled = { v: false };
    let countdown: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      let conn: Connection | null = null;
      try { conn = await apiFetch(`/api/connections/${id}`); } catch { return; }
      if (cancelled.v || !conn) return;

      const newStatus = conn.status;
      const prevStatus = prevStatusRef.current;
      prevStatusRef.current = newStatus;
      mutateConnRef.current(conn);

      // Transition → connected
      if (newStatus === "connected" && prevStatus !== "connected") {
        setQr(null); setQrError(null); setSetupSeconds(0);
        if (countdown) { clearInterval(countdown); countdown = null; }
        await loadProfile(cancelled);
        return;
      }

      if (newStatus === "connected") return;

      // Scanning/pending: poll QR
      if (newStatus === "scan_qr" || newStatus === "pending") {
        if (!countdown) {
          setSetupSeconds(0);
          countdown = setInterval(() => setSetupSeconds(s => s + 1), 1000);
        }
        try {
          const qrData = await apiFetch(`/api/connections/${id}/qr`);
          if (cancelled.v) return;
          if (qrData?.connected) {
            const fresh: Connection = { ...conn, status: "connected" };
            mutateConnRef.current(fresh);
            prevStatusRef.current = "connected";
            setQr(null); setQrError(null); setWahaConnecting(false); setSetupSeconds(0);
            if (countdown) { clearInterval(countdown); countdown = null; }
            await loadProfile(cancelled);
          } else if (qrData?.connecting) {
            setQr(null); setQrError(null); setWahaConnecting(true);
          } else if (qrData?.value) {
            setWahaConnecting(false); setQr(qrData); setQrError(null);
          }
        } catch (err) {
          if (!cancelled.v) setQrError(err instanceof Error ? err.message : "Error al cargar QR");
        }
        return;
      }

      if (qr) { setQr(null); setQrError(null); }
      if (countdown) { clearInterval(countdown); countdown = null; setSetupSeconds(0); }
    }

    tick();
    const t = setInterval(tick, 4000);
    return () => { cancelled.v = true; clearInterval(t); if (countdown) clearInterval(countdown); };
  }, [id, loadProfile]);

  useEffect(() => {
    if (connection?.name && !customName) setCustomName(connection.name);
  }, [connection?.name]);

  const fetchConn = useCallback(async () => {
    try { const d = await apiFetch(`/api/connections/${id}`); mutateConn(d); return d as Connection; }
    catch { return null; }
  }, [id, mutateConn]);

  // ─── Token handlers ─────────────────────────────────────────────────────────
  async function handleCreateToken() {
    setCreatingToken(true);
    try {
      const result = await apiFetch(`/api/tokens`, {
        method: "POST",
        body: JSON.stringify({ name: `Token ${connection?.name || id.slice(0, 8)}`, connectionId: id }),
      });
      setNewTokenValue(result.token);
      await loadTokens();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Error al crear token", "error");
    } finally { setCreatingToken(false); }
  }

  async function handleRevokeToken(tokenId: string) {
    const ok = await confirm({ title: "Revocar token", message: "El token dejará de funcionar inmediatamente.", confirmLabel: "Revocar", destructive: true });
    if (!ok) return;
    try {
      await apiFetch(`/api/tokens/${tokenId}`, { method: "DELETE" });
      setNewTokenValue(null);
      await loadTokens();
      toast("Token revocado", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Error al revocar token", "error");
    }
  }

  // ─── Connection action handlers ─────────────────────────────────────────────
  async function handleReconnect() {
    const ok = await confirm({
      title: "Reconectar número",
      message: "Esto cierra la sesión de WhatsApp y muestra el QR para volver a escanear.",
      confirmLabel: "Reconectar", destructive: false,
    });
    if (!ok) return;
    setReconnecting(true);
    prevStatusRef.current = null;
    mutateConn((p: Connection | null) => p ? { ...p, status: "scan_qr" } : p);
    setProfile(null); setQr(null); setWahaConnecting(false);
    try {
      await apiFetch(`/api/connections/${id}/reconnect`, { method: "POST" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Error al reconectar", "error");
    } finally { setReconnecting(false); }
  }

  async function handleResetWarmup() {
    setResettingWarmup(true);
    try {
      await apiFetch(`/api/connections/${id}/reset-warmup`, { method: "POST" });
      toast("Warmup reseteado — el contador vuelve a día 0", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Error al resetear warmup", "error");
    } finally { setResettingWarmup(false); }
  }

  async function handleRestart() {
    setRestarting(true);
    prevStatusRef.current = null;
    mutateConn((p: Connection | null) => p ? { ...p, status: "scan_qr" } : p);
    setProfile(null); setQr(null);
    try {
      await apiFetch(`/api/connections/${id}/restart`, { method: "POST" });
      await fetchConn();
    } catch (err) { toast(err instanceof Error ? err.message : "Error al reiniciar", "error"); }
    finally { setRestarting(false); }
  }

  async function handleDelete() {
    const ok = await confirm({ title: "Eliminar conexión", message: "Esta acción no se puede deshacer.", confirmLabel: "Eliminar", destructive: true });
    if (!ok) return;
    router.push("/dashboard/connections");
    apiFetch(`/api/connections/${id}`, { method: "DELETE" })
      .then(() => toast("Conexión eliminada", "success"))
      .catch(() => toast("Error al eliminar", "error"));
  }

  function handleNameSave() {
    setEditingName(false);
    apiFetch(`/api/connections/${id}`, { method: "PATCH", body: JSON.stringify({ name: customName.trim() }) })
      .then((u: any) => mutateConn(u)).catch(() => {});
  }

  const displayName = customName || connection?.name || "Conexión";

  if (loading) return <div><BackLink/><ConnectionDetailSkeleton /></div>;
  if (error && !connection) return (
    <div><BackLink/>
      <div className="mt-6 rounded-xl border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text">{error}</div>
    </div>
  );

  const isConnected = connection?.status === "connected";
  const isPending = connection?.status === "scan_qr" || connection?.status === "pending";

  return (
    <div className="animate-fade-in space-y-6">
      <BackLink />

      {/* Connection header card */}
      <div className="rounded-2xl border border-border-primary bg-bg-secondary px-5 py-4">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-wa-green/15 text-lg font-bold text-wa-green">
            {displayName[0]?.toUpperCase() || "W"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {editingName ? (
                <input ref={nameInputRef} type="text" value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  onBlur={handleNameSave}
                  onKeyDown={(e) => { if (e.key === "Enter") handleNameSave(); if (e.key === "Escape") { setEditingName(false); setCustomName(connection?.name || ""); } }}
                  className="rounded-lg border border-wa-green bg-bg-elevated px-2 py-0.5 text-base font-bold text-text-primary focus:outline-none focus:ring-1 focus:ring-wa-green"/>
              ) : (
                <button onClick={() => { setEditingName(true); setTimeout(() => nameInputRef.current?.focus(), 0); }}
                  className="group flex items-center gap-1.5">
                  <h1 className="text-base font-bold text-text-primary">{displayName}</h1>
                  <svg className="h-3.5 w-3.5 text-text-tertiary group-hover:text-wa-green transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                  </svg>
                </button>
              )}
              <StatusBadge status={connection?.status ?? "pending"} />
            </div>
            {profile && (
              <p className="mt-0.5 text-sm text-text-secondary">
                +{profile.id.replace("@c.us", "")}
                {profile.pushName && <span className="text-text-tertiary"> · {profile.pushName}</span>}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isConnected && (
              <>
                <button onClick={handleRestart} disabled={restarting}
                  className="flex items-center gap-1.5 rounded-xl border border-border-secondary px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-all disabled:opacity-50">
                  <svg className={`h-3.5 w-3.5 ${restarting ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                  </svg>
                  {restarting ? "Reiniciando…" : "Reiniciar"}
                </button>
                <button onClick={handleReconnect} disabled={reconnecting}
                  className="flex items-center gap-1.5 rounded-xl border border-blue-500/30 px-3 py-1.5 text-xs font-semibold text-blue-400 hover:bg-blue-500/10 transition-all disabled:opacity-50">
                  <svg className={`h-3.5 w-3.5 ${reconnecting ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"/>
                  </svg>
                  {reconnecting ? "Reconectando…" : "Reconectar"}
                </button>
                <button onClick={handleResetWarmup} disabled={resettingWarmup}
                  className="flex items-center gap-1.5 rounded-xl border border-amber-500/30 px-3 py-1.5 text-xs font-semibold text-amber-400 hover:bg-amber-500/10 transition-all disabled:opacity-50">
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z"/>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 00.495-7.467 5.99 5.99 0 00-1.925 3.546 5.974 5.974 0 01-2.133-1A3.75 3.75 0 0012 18z"/>
                  </svg>
                  {resettingWarmup ? "Reseteando…" : "Reset warmup"}
                </button>
              </>
            )}
            <button onClick={handleDelete}
              className="rounded-xl border border-status-error-border px-3 py-1.5 text-xs font-semibold text-status-error-text hover:bg-status-error-bg transition-all">
              Eliminar
            </button>
          </div>
        </div>
      </div>

      {/* QR section */}
      {isPending && (
        <div className="rounded-2xl border border-border-secondary bg-bg-secondary overflow-hidden">
          <div className="px-5 py-4 border-b border-border-primary flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-status-warning-text animate-pulse-dot"/>
            <h2 className="text-sm font-semibold text-text-primary">Vinculá tu WhatsApp</h2>
          </div>
          <div className="p-6 flex flex-col sm:flex-row items-center gap-8">
            <div className="shrink-0">
              {qr && !wahaConnecting ? (
                <div className="rounded-2xl bg-white p-3 shadow-xl">
                  <img src={`data:${qr.mimetype};base64,${qr.value}`} alt="QR Code" className="h-52 w-52 rounded-xl"/>
                </div>
              ) : (
                <div className="flex h-[220px] w-[220px] flex-col items-center justify-center gap-3 rounded-2xl bg-bg-elevated">
                  <svg className="h-8 w-8 animate-spin text-wa-green" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                    <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  <p className="text-xs text-text-tertiary text-center px-4">
                    {wahaConnecting ? "QR escaneado — conectando…"
                      : setupSeconds > 0 ? `Iniciando sesión… ${setupSeconds}s` : "Iniciando sesión…"}
                  </p>
                  {!wahaConnecting && (
                    <div className="flex flex-col items-center gap-1.5">
                      {setupSeconds >= 15 && (
                        <button onClick={handleRestart} disabled={restarting}
                          className="text-xs text-wa-green underline hover:text-wa-green-dark disabled:opacity-50">
                          {restarting ? "Reiniciando…" : "Reintentar"}
                        </button>
                      )}
                      <button onClick={handleReconnect} disabled={reconnecting}
                        className="text-xs text-blue-400 underline hover:text-blue-300 disabled:opacity-50">
                        {reconnecting ? "Reconectando…" : "Nuevo QR"}
                      </button>
                      {qrError && setupSeconds >= 20 && (
                        <p className="text-xs text-status-error-text text-center px-3">{qrError}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="space-y-4 text-sm">
              <h3 className="font-semibold text-text-primary">Cómo vincular tu teléfono:</h3>
              {[
                { n: 1, text: "Abrí WhatsApp en tu teléfono" },
                { n: 2, text: "Tocá Más opciones ⋮ o Configuración" },
                { n: 3, text: "Tocá Dispositivos vinculados" },
                { n: 4, text: "Tocá Vincular dispositivo" },
                { n: 5, text: "Escaneá este código con la cámara" },
              ].map(({ n, text }) => (
                <div key={n} className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-wa-green/15 text-xs font-bold text-wa-green">{n}</span>
                  <span className="text-text-secondary leading-snug pt-0.5">{text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Main content when connected */}
      {isConnected && (
        <>
          <div className="flex border-b border-border-primary gap-1">
            {(["credentials", "webhooks"] as const).map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-semibold transition-all border-b-2 -mb-px
                  ${activeTab === tab
                    ? "border-wa-green text-wa-green"
                    : "border-transparent text-text-tertiary hover:text-text-secondary"}`}>
                {tab === "credentials" ? "🔑 Credenciales" : "🔗 Webhooks"}
              </button>
            ))}
          </div>

          {activeTab === "credentials" && (
            <CredentialsTab
              connectionId={id}
              tokens={tokens}
              tokensLoading={tokensLoading}
              newTokenValue={newTokenValue}
              creatingToken={creatingToken}
              onCreateToken={handleCreateToken}
              onRevokeToken={handleRevokeToken}
              onDismissToken={() => setNewTokenValue(null)}
            />
          )}
          {activeTab === "webhooks" && <WebhookList connectionId={id} apiUrl={typeof window !== "undefined" ? ((window as any).__API_URL__ || "https://api.recursomusical.com.mx") : "https://api.recursomusical.com.mx"} activeTokenValue={newTokenValue} />}
        </>
      )}

      {/* Failed state */}
      {connection?.status === "failed" && (
        <div className="rounded-2xl border border-status-error-border bg-status-error-bg p-5 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-status-error-text">Conexión fallida</h2>
            <p className="mt-0.5 text-xs text-status-error-text/70">Reiniciá para intentar conectar de nuevo.</p>
          </div>
          <button onClick={handleRestart} disabled={restarting}
            className="rounded-xl border border-status-error-border px-4 py-2 text-sm font-bold text-status-error-text hover:bg-status-error-bg/50 transition-all disabled:opacity-50">
            {restarting ? "Reiniciando…" : "Reiniciar"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Credentials Tab ──────────────────────────────────────────────────────────

function EnvBlock({ lines }: { lines: { key: string; value: string }[] }) {
  const text = lines.map(l => `${l.key}=${l.value}`).join("\n");
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }
  return (
    <div className="relative rounded-xl border border-border-secondary bg-bg-elevated">
      <pre className="overflow-x-auto px-5 py-4 text-sm font-mono text-text-primary leading-relaxed">
        {lines.map(l => (
          <div key={l.key}>
            <span className="text-wa-green">{l.key}</span>
            <span className="text-text-tertiary">=</span>
            <span className="text-text-secondary">{l.value}</span>
          </div>
        ))}
      </pre>
      <button onClick={copy}
        className="absolute right-3 top-3 flex items-center gap-1.5 rounded-lg border border-border-secondary bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover transition-all">
        {copied ? (
          <><svg className="h-3.5 w-3.5 text-wa-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>Copiado</>
        ) : (
          <><svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/></svg>Copiar</>
        )}
      </button>
    </div>
  );
}

function CredentialsTab({
  connectionId, tokens, tokensLoading, newTokenValue,
  creatingToken, onCreateToken, onRevokeToken, onDismissToken,
}: {
  connectionId: string; tokens: ApiToken[]; tokensLoading: boolean;
  newTokenValue: string | null; creatingToken: boolean;
  onCreateToken: () => void; onRevokeToken: (id: string) => void; onDismissToken: () => void;
}) {
  const apiUrl = (typeof window !== "undefined" && (window as any).__API_URL__)
    || "https://api.recursomusical.com.mx";

  const activeToken = tokens.find(t => t.active);

  return (
    <div className="space-y-6">
      {/* Info banner */}
      <div className="flex items-start gap-3 rounded-2xl border border-border-primary bg-bg-secondary px-5 py-4">
        <svg className="h-5 w-5 mt-0.5 shrink-0 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/>
        </svg>
        <div className="text-sm text-text-secondary leading-relaxed">
          El <span className="font-mono text-text-primary text-xs bg-bg-elevated px-1.5 py-0.5 rounded">WAGO_CONNECTION_ID</span> es permanente — nunca cambia aunque reinicies o cambies el número. Solo cambia si <strong>eliminás</strong> la conexión.
        </div>
      </div>

      {/* Token section */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">Token de acceso</h3>
          {!activeToken && (
            <button onClick={onCreateToken} disabled={creatingToken}
              className="flex items-center gap-1.5 rounded-xl bg-wa-green px-3 py-1.5 text-xs font-semibold text-text-inverse hover:bg-wa-green-dark transition-all disabled:opacity-50">
              {creatingToken ? (
                <><svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Generando…</>
              ) : (
                <><svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>Generar token</>
              )}
            </button>
          )}
        </div>

        {tokensLoading ? (
          <div className="flex items-center gap-2 text-xs text-text-tertiary py-3">
            <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            Cargando tokens…
          </div>
        ) : activeToken ? (
          <div className="rounded-2xl border border-border-primary bg-bg-secondary px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-text-primary">{activeToken.name}</p>
                <p className="font-mono text-xs text-text-tertiary mt-0.5">{activeToken.tokenPrefix}</p>
              </div>
              <button onClick={() => onRevokeToken(activeToken.id)}
                className="text-xs text-red-400 hover:text-red-300 border border-red-500/20 rounded-lg px-3 py-1.5 hover:bg-red-500/10 transition-all">
                Revocar
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-text-tertiary">Sin token — generá uno para conectar tu proyecto a esta conexión.</p>
        )}

        {newTokenValue && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <p className="text-xs font-semibold text-amber-400 mb-2">Guardá el token ahora — no se mostrará de nuevo</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all text-xs font-mono text-text-primary bg-bg-elevated rounded-lg px-3 py-2 border border-border-secondary">
                {newTokenValue}
              </code>
              <button onClick={() => navigator.clipboard.writeText(newTokenValue)}
                className="shrink-0 rounded-lg border border-border-secondary bg-bg-secondary p-2 hover:bg-bg-hover transition-all">
                <svg className="h-4 w-4 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/>
                </svg>
              </button>
            </div>
            <button onClick={onDismissToken} className="mt-2 text-xs text-amber-400/70 hover:text-amber-400 transition-colors">
              Ya lo guardé ✓
            </button>
          </div>
        )}
      </section>

      {/* ENV block */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-text-primary">Variables de entorno</h3>
        <EnvBlock lines={[
          { key: "WAGO_URL", value: apiUrl },
          { key: "WAGO_TOKEN", value: activeToken ? activeToken.tokenPrefix.replace("...", "<tu-token-completo>") : "<genera-un-token-arriba>" },
          { key: "WAGO_CONNECTION_ID", value: connectionId },
        ]} />
        {!activeToken && (
          <p className="mt-2 text-xs text-text-tertiary">Generá un token para ver el valor completo de <span className="font-mono">WAGO_TOKEN</span>.</p>
        )}
      </section>

      {newTokenValue && activeToken && (
        <section>
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Listo para copiar al .env</h3>
          <EnvBlock lines={[
            { key: "WAGO_URL", value: apiUrl },
            { key: "WAGO_TOKEN", value: newTokenValue },
            { key: "WAGO_CONNECTION_ID", value: connectionId },
          ]} />
        </section>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/dashboard/connections"
      className="inline-flex items-center gap-1.5 text-sm text-text-tertiary hover:text-text-primary transition-colors">
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/>
      </svg>
      Conexiones
    </Link>
  );
}
