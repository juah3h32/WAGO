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
interface ChatItem {
  id: string; name?: string; timestamp: number;
  lastMessage?: { body: string; timestamp: number; fromMe: boolean };
  unreadCount?: number;
}
interface WaProfile { id: string; pushName: string; }

// Module-level avatar cache
const avatarCache = new Map<string, string | null>();

function ChatAvatar({ connectionId, chatId, name, size = "h-10 w-10" }: {
  connectionId: string; chatId: string; name?: string; size?: string;
}) {
  const key = `${connectionId}:${chatId}`;
  const [url, setUrl] = useState<string | null | undefined>(
    avatarCache.has(key) ? avatarCache.get(key)! : undefined
  );
  useEffect(() => {
    if (avatarCache.has(key)) return;
    let cancelled = false;
    apiFetch(`/api/connections/${connectionId}/contacts/${encodeURIComponent(chatId)}/picture`)
      .then((d: { profilePictureUrl: string | null }) => {
        if (!cancelled) { avatarCache.set(key, d.profilePictureUrl); setUrl(d.profilePictureUrl); }
      })
      .catch(() => {
        if (!cancelled) { avatarCache.set(key, null); setUrl(null); }
      });
    return () => { cancelled = true; };
  }, [connectionId, chatId, key]);

  const letter = (name?.[0] || chatId[0] || "?").toUpperCase();
  const colors = ["bg-[#1e4d6b]","bg-[#4d3319]","bg-[#2d4d1e]","bg-[#4d1e4d]","bg-[#1e3d4d]"];
  const color = colors[chatId.charCodeAt(0) % colors.length];

  if (url) return <img src={url} alt={name || chatId} className={`${size} shrink-0 rounded-full object-cover`}/>;
  return (
    <div className={`${size} ${color} flex shrink-0 items-center justify-center rounded-full text-sm font-bold text-white/90`}>
      {letter}
    </div>
  );
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
  const [setupSeconds, setSetupSeconds] = useState(0);
  const [wahaConnecting, setWahaConnecting] = useState(false); // QR scanned, transitioning
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [profile, setProfile] = useState<WaProfile | null>(null);
  const [selectedChat, setSelectedChat] = useState<ChatItem | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [sendText, setSendText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [editingName, setEditingName] = useState(false);
  const [customName, setCustomName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [mediaMode, setMediaMode] = useState<null | "image" | "file" | "voice">(null);
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaCaption, setMediaCaption] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "webhooks" | "credentials">("chat");

  // Credentials tab state
  const [scopedTokens, setScopedTokens] = useState<any[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [newTokenValue, setNewTokenValue] = useState<string | null>(null);

  // Refs used inside the polling loop (avoid stale closures)
  const prevStatusRef = useRef<string | null>(null);
  const chatsLoadedRef = useRef(false);
  const mutateConnRef = useRef(mutateConn);
  mutateConnRef.current = mutateConn;

  // ─── Load chats helper ────────────────────────────────────────────────────
  const loadChats = useCallback(async (cancelled: { v: boolean }) => {
    setChatsLoading(true);
    try {
      const [me, chatsData] = await Promise.all([
        apiFetch(`/api/connections/${id}/me`).catch(() => null),
        apiFetch(`/api/connections/${id}/chats`).catch(() => []),
      ]);
      if (cancelled.v) return;
      if (me) setProfile(me);
      setChats(chatsData ?? []);
      chatsLoadedRef.current = true;
    } finally {
      if (!cancelled.v) setChatsLoading(false);
    }
  }, [id]);

  // ─── Single master polling loop ───────────────────────────────────────────
  // One interval handles both connection status AND QR polling.
  // Explicit transition detection via prevStatusRef — no competing effects.
  useEffect(() => {
    const cancelled = { v: false };
    let countdown: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      // 1. Fetch fresh connection state
      let conn: Connection | null = null;
      try { conn = await apiFetch(`/api/connections/${id}`); } catch { return; }
      if (cancelled.v || !conn) return;

      const newStatus = conn.status;
      const prevStatus = prevStatusRef.current;
      prevStatusRef.current = newStatus;

      // Update component state
      mutateConnRef.current(conn);

      // 2. Transition → connected: clear QR, load chats immediately
      if (newStatus === "connected" && prevStatus !== "connected") {
        setQr(null);
        setQrError(null);
        setSetupSeconds(0);
        if (countdown) { clearInterval(countdown); countdown = null; }
        chatsLoadedRef.current = false; // force reload on reconnect
        await loadChats(cancelled);
        return;
      }

      // 3. Already connected but chats not loaded yet (e.g. page opened fresh)
      if (newStatus === "connected" && !chatsLoadedRef.current) {
        await loadChats(cancelled);
        return;
      }

      // 4. Scanning/pending: poll QR + run countdown
      if (newStatus === "scan_qr" || newStatus === "pending") {
        // Start countdown if not running
        if (!countdown) {
          setSetupSeconds(0);
          countdown = setInterval(() => setSetupSeconds(s => s + 1), 1000);
        }

        try {
          const qrData = await apiFetch(`/api/connections/${id}/qr`);
          if (cancelled.v) return;

          if (qrData?.connected) {
            // WAHA WORKING — transition to connected
            const fresh: Connection = { ...conn, status: "connected" };
            mutateConnRef.current(fresh);
            prevStatusRef.current = "connected";
            setQr(null);
            setQrError(null);
            setWahaConnecting(false);
            setSetupSeconds(0);
            if (countdown) { clearInterval(countdown); countdown = null; }
            chatsLoadedRef.current = false;
            await loadChats(cancelled);
          } else if (qrData?.connecting) {
            // QR scanned — WAHA is CONNECTING (transitioning). Show spinner, keep polling.
            setQr(null);
            setQrError(null);
            setWahaConnecting(true);
          } else if (qrData?.value) {
            setWahaConnecting(false);
            setQr(qrData);
            setQrError(null);
          }
        } catch (err) {
          if (!cancelled.v) setQrError(err instanceof Error ? err.message : "Error al cargar QR");
        }
        return;
      }

      // 5. Not scanning: ensure QR is cleared
      if (qr) { setQr(null); setQrError(null); }
      if (countdown) { clearInterval(countdown); countdown = null; setSetupSeconds(0); }
    }

    // Run immediately, then every 2.5s
    tick();
    const t = setInterval(tick, 2500);

    return () => {
      cancelled.v = true;
      clearInterval(t);
      if (countdown) clearInterval(countdown);
    };
  }, [id, loadChats]); // loadChats is stable (only depends on id)

  // Update name input when connection loads
  useEffect(() => {
    if (connection?.name && !customName) setCustomName(connection.name);
  }, [connection?.name]);

  // fetchConn exposed for restart/reset actions
  const fetchConn = useCallback(async () => {
    try { const d = await apiFetch(`/api/connections/${id}`); mutateConn(d); return d as Connection; }
    catch { return null; }
  }, [id, mutateConn]);

  // Load messages when chat selected
  useEffect(() => {
    if (!selectedChat || !id) return;
    let cancelled = false;
    setMessagesLoading(true);
    setMessages([]);
    apiFetch(`/api/connections/${id}/chats/${encodeURIComponent(selectedChat.id)}/messages`)
      .then((msgs: any) => {
        if (!cancelled && Array.isArray(msgs)) {
          setMessages(msgs.reverse());
          setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
        }
      })
      .catch(() => { if (!cancelled) setMessages([]); })
      .finally(() => { if (!cancelled) setMessagesLoading(false); });
    return () => { cancelled = true; };
  }, [selectedChat?.id, id]);

  async function loadScopedTokens() {
    setTokensLoading(true);
    try {
      const all = await apiFetch("/api/tokens");
      setScopedTokens((all ?? []).filter((t: any) => t.connectionId === id));
    } catch { /* ignore */ }
    finally { setTokensLoading(false); }
  }

  async function handleCreateScopedToken() {
    setCreatingToken(true);
    setNewTokenValue(null);
    try {
      const created = await apiFetch("/api/tokens", {
        method: "POST",
        body: JSON.stringify({ name: `Token ${connection?.name || id.slice(0, 8)}`, connectionId: id }),
      });
      setNewTokenValue(created.token);
      await loadScopedTokens();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Error al crear token", "error");
    } finally { setCreatingToken(false); }
  }

  async function handleRevokeToken(tokenId: string) {
    try {
      await apiFetch(`/api/tokens/${tokenId}`, { method: "DELETE" });
      setScopedTokens(p => p.filter(t => t.id !== tokenId));
      setNewTokenValue(null);
      toast("Token revocado", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Error al revocar", "error");
    }
  }

  async function handleResetWarmup() {
    setResettingWarmup(true);
    try {
      await apiFetch(`/api/connections/${id}/reset-warmup`, { method: "POST" });
      toast("Warmup reseteado — el contador vuelve a día 0", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Error al resetear warmup", "error");
    } finally {
      setResettingWarmup(false);
    }
  }

  async function handleRestart() {
    setRestarting(true);
    // Reset state so the master loop detects transition fresh
    prevStatusRef.current = null;
    chatsLoadedRef.current = false;
    mutateConn((p: Connection | null) => p ? { ...p, status: "scan_qr" } : p);
    setChats([]); setProfile(null); setSelectedChat(null); setQr(null);
    try {
      await apiFetch(`/api/connections/${id}/restart`, { method: "POST" });
      await fetchConn();
    } catch (err) { toast(err instanceof Error ? err.message : "Error al reiniciar", "error"); }
    finally { setRestarting(false); }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: "Eliminar conexión",
      message: "Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      destructive: true,
    });
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

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedChat || !sendText.trim()) return;
    const text = sendText.trim();
    setSending(true);
    const opt = { id: `tmp-${Date.now()}`, fromMe: true, body: text, timestamp: Math.floor(Date.now() / 1000) };
    setMessages((p) => [...p, opt]);
    setSendText("");
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    try {
      await apiFetch(`/api/connections/${id}/send`, {
        method: "POST",
        body: JSON.stringify({ chatId: selectedChat.id, text }),
      });
    } catch (err) {
      setMessages((p) => p.filter((m) => m.id !== opt.id));
      toast(err instanceof Error ? err.message : "Error al enviar", "error");
    } finally { setSending(false); }
  }

  async function handleSendMedia(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedChat || !mediaMode) return;
    if (!mediaFile && !mediaUrl.trim()) return;
    setSending(true);
    try {
      const payload: any = { chatId: selectedChat.id, type: mediaMode };
      if (mediaFile) {
        const b64 = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res((r.result as string).split(",")[1] || "");
          r.onerror = rej;
          r.readAsDataURL(mediaFile);
        });
        payload.mediaData = b64; payload.mimetype = mediaFile.type; payload.filename = mediaFile.name;
      } else { payload.mediaUrl = mediaUrl.trim(); }
      if (mediaMode !== "voice" && mediaCaption.trim()) payload.caption = mediaCaption.trim();
      await apiFetch(`/api/connections/${id}/send-media`, { method: "POST", body: JSON.stringify(payload) });
      toast("Archivo enviado", "success");
      exitMedia();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      toast(msg.includes("Plus") ? "Requiere WAHA Plus para enviar archivos" : msg || "Error", "error");
    } finally { setSending(false); }
  }

  function exitMedia() {
    setMediaMode(null); setMediaUrl(""); setMediaCaption(""); setMediaFile(null);
    setShowAttachMenu(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleTextareaKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(e as any); }
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
          {/* Avatar */}
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-wa-green/15 text-lg font-bold text-wa-green">
            {displayName[0]?.toUpperCase() || "W"}
          </div>

          {/* Name + status */}
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

          {/* Actions */}
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
                <button onClick={handleResetWarmup} disabled={resettingWarmup} title="Resetear límite de calentamiento (warmup)"
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
            {/* QR display */}
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
                    {wahaConnecting
                      ? "QR escaneado — conectando…"
                      : setupSeconds > 0
                        ? `Iniciando sesión… ${setupSeconds}s`
                        : "Iniciando sesión…"}
                  </p>
                  {!wahaConnecting && setupSeconds >= 15 && (
                    <button
                      onClick={handleRestart}
                      disabled={restarting}
                      className="text-xs text-wa-green underline hover:text-wa-green-dark disabled:opacity-50"
                    >
                      {restarting ? "Reiniciando…" : "Reintentar"}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Instructions */}
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
          {/* Tabs */}
          <div className="flex border-b border-border-primary gap-1">
            {([
              { key: "chat", label: "💬 Chat" },
              { key: "webhooks", label: "🔗 Webhooks" },
              { key: "credentials", label: "🔑 Credenciales" },
            ] as const).map(({ key, label }) => (
              <button key={key}
                onClick={() => {
                  setActiveTab(key);
                  if (key === "credentials") loadScopedTokens();
                }}
                className={`px-4 py-2 text-sm font-semibold transition-all border-b-2 -mb-px
                  ${activeTab === key
                    ? "border-wa-green text-wa-green"
                    : "border-transparent text-text-tertiary hover:text-text-secondary"}`}>
                {label}
              </button>
            ))}
          </div>

          {activeTab === "chat" && (
            <div className="rounded-2xl border border-border-primary bg-bg-secondary overflow-hidden" style={{ height: "560px" }}>
              <div className="flex h-full">
                {/* ── Chat list ── */}
                <div className="flex w-72 shrink-0 flex-col border-r border-border-primary">
                  <div className="border-b border-border-primary px-4 py-3">
                    <h2 className="text-sm font-bold text-text-primary">Chats</h2>
                    <p className="text-xs text-text-tertiary">{chats.length} conversaciones</p>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {chatsLoading ? (
                      <div className="flex h-full flex-col items-center justify-center gap-3">
                        <svg className="h-6 w-6 animate-spin text-wa-green" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                          <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                        </svg>
                        <p className="text-xs text-text-tertiary">Cargando chats…</p>
                      </div>
                    ) : chats.length === 0 ? (
                      <div className="flex h-full items-center justify-center p-6 text-center">
                        <p className="text-xs text-text-tertiary">No hay chats disponibles</p>
                      </div>
                    ) : chats.map((chat) => {
                      const isSelected = selectedChat?.id === chat.id;
                      const time = chat.lastMessage
                        ? new Date(chat.lastMessage.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                        : "";
                      return (
                        <button key={chat.id} type="button"
                          onClick={() => setSelectedChat(chat)}
                          className={`flex w-full items-center gap-3 border-b border-border-primary/40 px-4 py-3 text-left transition-colors
                            ${isSelected ? "bg-bg-elevated border-l-2 border-l-wa-green" : "border-l-2 border-l-transparent hover:bg-bg-hover"}`}>
                          <ChatAvatar connectionId={id} chatId={chat.id} name={chat.name}/>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-1">
                              <p className="truncate text-sm font-semibold text-text-primary">
                                {chat.name || chat.id.replace("@c.us","").replace("@g.us","")}
                              </p>
                              {time && <span className="shrink-0 text-[10px] text-text-tertiary">{time}</span>}
                            </div>
                            {chat.lastMessage && (
                              <p className="mt-0.5 truncate text-xs text-text-tertiary">
                                {chat.lastMessage.fromMe ? "Tú: " : ""}{chat.lastMessage.body}
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* ── Message area ── */}
                <div className="flex flex-1 flex-col min-w-0" style={{ background: "var(--color-bg-primary)" }}>
                  {selectedChat ? (
                    <>
                      {/* Chat header */}
                      <div className="flex items-center gap-3 border-b border-border-primary px-4 py-3 bg-bg-secondary">
                        <ChatAvatar connectionId={id} chatId={selectedChat.id} name={selectedChat.name} size="h-9 w-9"/>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-text-primary">
                            {selectedChat.name || selectedChat.id.replace("@c.us","").replace("@g.us","")}
                          </p>
                          <p className="truncate text-[10px] text-text-tertiary font-mono">{selectedChat.id}</p>
                        </div>
                        <CopyButton text={selectedChat.id}/>
                      </div>

                      {/* Messages */}
                      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1"
                        style={{ backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.02) 1px, transparent 0)", backgroundSize: "24px 24px" }}>
                        {messagesLoading ? (
                          <div className="flex h-full items-center justify-center">
                            <svg className="h-6 w-6 animate-spin text-wa-green" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                              <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                            </svg>
                          </div>
                        ) : messages.length === 0 ? (
                          <div className="flex h-full items-center justify-center">
                            <p className="text-sm text-text-tertiary">Sin mensajes</p>
                          </div>
                        ) : (
                          <>
                            {messages.map((msg, i) => {
                              if (!msg.body) return null;
                              const isMe = msg.fromMe;
                              const time = msg.timestamp
                                ? new Date(msg.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                                : "";
                              const isTemp = msg.id?.startsWith("tmp-");
                              return (
                                <div key={msg.id || i} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
                                  <div className={`max-w-[72%] rounded-2xl px-3.5 py-2 shadow-sm
                                    ${isMe
                                      ? "rounded-tr-sm bg-wa-bubble-out"
                                      : "rounded-tl-sm bg-wa-bubble-in"
                                    }`}>
                                    <p className="text-sm leading-relaxed text-text-primary whitespace-pre-wrap break-words">{msg.body}</p>
                                    <div className={`mt-1 flex items-center gap-1 ${isMe ? "justify-end" : "justify-start"}`}>
                                      <span className="text-[10px] text-text-tertiary">{time}</span>
                                      {isMe && (
                                        <svg className={`h-3.5 w-3.5 ${isTemp ? "text-text-tertiary" : "text-[#53bdeb]"}`} fill="currentColor" viewBox="0 0 16 11">
                                          {isTemp
                                            ? <path d="M10.307 1L5.854 7.01l-1.99-1.99L3 5.884l2.854 2.854L11.17 1.864z"/>
                                            : <path d="M11.071.653L6.235 5.971 4.93 4.665l-.864.865 2.17 2.17 5.7-6.182zm3.394 0L9.629 5.971 8.324 4.665l-.864.865L9.63 7.7l5.7-6.182zm-11.394 7l-2.17-2.17L0 6.347l2.17 2.17 5.7-6.182-.864-.865z"/>
                                          }
                                        </svg>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                            <div ref={messagesEndRef}/>
                          </>
                        )}
                      </div>

                      {/* Input area */}
                      {mediaMode ? (
                        <form onSubmit={handleSendMedia} className="border-t border-border-primary bg-bg-secondary px-4 py-3 space-y-3">
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={exitMedia}
                              className="rounded-full p-1.5 text-text-tertiary hover:bg-bg-elevated hover:text-text-primary transition-all">
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/>
                              </svg>
                            </button>
                            <span className="text-xs font-bold uppercase tracking-wide text-wa-green">
                              {mediaMode === "image" ? "📷 Imagen" : mediaMode === "file" ? "📎 Archivo" : "🎤 Audio"}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={() => fileInputRef.current?.click()}
                              className="shrink-0 rounded-xl border border-border-secondary bg-bg-elevated px-3 py-2 text-xs font-semibold text-text-secondary hover:bg-bg-hover transition-all">
                              {mediaFile ? mediaFile.name.slice(0,22) + (mediaFile.name.length > 22 ? "…" : "") : "Elegir archivo"}
                            </button>
                            <input ref={fileInputRef} type="file" className="hidden"
                              accept={mediaMode === "image" ? "image/*" : mediaMode === "voice" ? "audio/*" : "*/*"}
                              onChange={(e) => { const f = e.target.files?.[0]; if (f) { setMediaFile(f); setMediaUrl(""); } }}/>
                            <span className="text-xs text-text-tertiary">o</span>
                            <input type="url" value={mediaUrl} placeholder="URL del archivo"
                              onChange={(e) => { setMediaUrl(e.target.value); setMediaFile(null); }}
                              disabled={!!mediaFile}
                              className="flex-1 rounded-xl border border-border-secondary bg-bg-input px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green/30 transition-all disabled:opacity-40"/>
                          </div>
                          {mediaMode !== "voice" && (
                            <input type="text" value={mediaCaption} placeholder="Pie de foto (opcional)"
                              onChange={(e) => setMediaCaption(e.target.value)}
                              className="block w-full rounded-xl border border-border-secondary bg-bg-input px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green/30 transition-all"/>
                          )}
                          <button type="submit" disabled={sending || (!mediaFile && !mediaUrl.trim())}
                            className="w-full rounded-xl bg-wa-green py-2 text-sm font-bold text-text-inverse hover:bg-wa-green-dark transition-all disabled:opacity-50">
                            {sending ? "Enviando…" : "Enviar"}
                          </button>
                        </form>
                      ) : (
                        <div className="border-t border-border-primary bg-bg-secondary px-3 py-2.5">
                          <form onSubmit={handleSend} className="flex items-end gap-2">
                            {/* Attach button */}
                            <div className="relative">
                              <button type="button" onClick={() => setShowAttachMenu((v) => !v)}
                                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-tertiary hover:bg-bg-elevated hover:text-text-primary transition-all">
                                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
                                </svg>
                              </button>
                              {showAttachMenu && (
                                <div className="absolute bottom-12 left-0 w-40 rounded-2xl border border-border-secondary bg-bg-elevated shadow-2xl overflow-hidden">
                                  {([
                                    { type: "image" as const, label: "Imagen", icon: "📷" },
                                    { type: "file" as const, label: "Documento", icon: "📎" },
                                    { type: "voice" as const, label: "Audio", icon: "🎤" },
                                  ]).map(({ type, label, icon }) => (
                                    <button key={type} type="button"
                                      onClick={() => { setMediaMode(type); setShowAttachMenu(false); }}
                                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-text-primary hover:bg-bg-hover transition-colors">
                                      <span>{icon}</span><span>{label}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Text input */}
                            <textarea
                              ref={textareaRef}
                              value={sendText}
                              onChange={(e) => setSendText(e.target.value)}
                              onKeyDown={handleTextareaKey}
                              placeholder="Escribí un mensaje…"
                              disabled={sending}
                              rows={1}
                              style={{ resize: "none", maxHeight: "120px" }}
                              className="flex-1 rounded-2xl border border-border-secondary bg-bg-input px-4 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green/30 transition-all disabled:opacity-50 leading-relaxed"
                            />

                            {/* Send button */}
                            <button type="submit" disabled={sending || !sendText.trim()}
                              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-wa-green text-text-inverse hover:bg-wa-green-dark transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                              {sending ? (
                                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                                </svg>
                              ) : (
                                <svg className="h-5 w-5 translate-x-[1px]" fill="currentColor" viewBox="0 0 24 24">
                                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                                </svg>
                              )}
                            </button>
                          </form>
                          <p className="mt-1.5 px-2 text-[10px] text-text-tertiary">Enter para enviar · Shift+Enter para nueva línea</p>
                        </div>
                      )}
                    </>
                  ) : (
                    /* No chat selected */
                    <div className="flex h-full flex-col items-center justify-center gap-3 text-center p-8">
                      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-bg-elevated">
                        <svg className="h-8 w-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                        </svg>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-text-secondary">Seleccioná un chat</p>
                        <p className="text-xs text-text-tertiary mt-0.5">Para leer y enviar mensajes</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === "webhooks" && <WebhookList connectionId={id}/>}

          {activeTab === "credentials" && (
            <CredentialsTab
              connectionId={id}
              tokens={scopedTokens}
              tokensLoading={tokensLoading}
              newTokenValue={newTokenValue}
              creatingToken={creatingToken}
              onCreateToken={handleCreateScopedToken}
              onRevokeToken={handleRevokeToken}
              onDismissToken={() => setNewTokenValue(null)}
            />
          )}
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
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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
      <button
        onClick={copy}
        className="absolute right-3 top-3 flex items-center gap-1.5 rounded-lg border border-border-secondary bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover transition-all"
      >
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
  connectionId,
  tokens,
  tokensLoading,
  newTokenValue,
  creatingToken,
  onCreateToken,
  onRevokeToken,
  onDismissToken,
}: {
  connectionId: string;
  tokens: any[];
  tokensLoading: boolean;
  newTokenValue: string | null;
  creatingToken: boolean;
  onCreateToken: () => void;
  onRevokeToken: (id: string) => void;
  onDismissToken: () => void;
}) {
  const apiUrl = typeof window !== "undefined"
    ? (window.location.hostname.includes("recursomusical.com.mx")
        ? "https://api.recursomusical.com.mx"
        : "http://localhost:3001")
    : "https://api.recursomusical.com.mx";

  const activeToken = tokens.find(t => t.active);

  return (
    <div className="space-y-6">
      {/* Info banner */}
      <div className="flex items-start gap-3 rounded-2xl border border-border-primary bg-bg-secondary px-5 py-4">
        <svg className="h-5 w-5 mt-0.5 shrink-0 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/>
        </svg>
        <div className="text-sm text-text-secondary leading-relaxed">
          El <span className="font-mono text-text-primary text-xs bg-bg-elevated px-1.5 py-0.5 rounded">WAHOOKS_CONNECTION_ID</span> es permanente — nunca cambia aunque reinicies o cambies el número de teléfono. Solo cambia si <strong>eliminas</strong> la conexión.
        </div>
      </div>

      {/* Token section */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">Token de acceso</h3>
          {!activeToken && (
            <button
              onClick={onCreateToken}
              disabled={creatingToken}
              className="flex items-center gap-1.5 rounded-xl bg-wa-green px-3 py-1.5 text-xs font-semibold text-text-inverse hover:bg-wa-green-dark transition-all disabled:opacity-50"
            >
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
              <button
                onClick={() => onRevokeToken(activeToken.id)}
                className="text-xs text-red-400 hover:text-red-300 border border-red-500/20 rounded-lg px-3 py-1.5 hover:bg-red-500/10 transition-all"
              >
                Revocar
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-text-tertiary">Sin token — genera uno para acceder a esta conexión desde tu proyecto.</p>
        )}

        {/* New token banner */}
        {newTokenValue && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <p className="text-xs font-semibold text-amber-400 mb-2">Guarda el token ahora — no se mostrará de nuevo</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all text-xs font-mono text-text-primary bg-bg-elevated rounded-lg px-3 py-2 border border-border-secondary">
                {newTokenValue}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(newTokenValue)}
                className="shrink-0 rounded-lg border border-border-secondary bg-bg-secondary p-2 hover:bg-bg-hover transition-all"
              >
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
          { key: "WAHOOKS_URL", value: apiUrl },
          { key: "WAHOOKS_TOKEN", value: activeToken ? activeToken.tokenPrefix.replace("...", "<tu-token-completo>") : "<genera-un-token-arriba>" },
          { key: "WAHOOKS_CONNECTION_ID", value: connectionId },
        ]} />
        {activeToken && newTokenValue && (
          <p className="mt-2 text-xs text-text-tertiary">
            Reemplaza <span className="font-mono">{activeToken.tokenPrefix.replace("...", "...")}</span> por el token completo que copiaste arriba.
          </p>
        )}
        {!activeToken && (
          <p className="mt-2 text-xs text-text-tertiary">Genera un token para ver el valor completo de <span className="font-mono">WAHOOKS_TOKEN</span>.</p>
        )}
      </section>

      {/* ENV with full token if just created */}
      {newTokenValue && activeToken && (
        <section>
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Listo para copiar al .env</h3>
          <EnvBlock lines={[
            { key: "WAHOOKS_URL", value: apiUrl },
            { key: "WAHOOKS_TOKEN", value: newTokenValue },
            { key: "WAHOOKS_CONNECTION_ID", value: connectionId },
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
