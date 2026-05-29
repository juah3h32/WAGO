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
  const connRef = useRef<Connection | null>(null);
  connRef.current = connection;

  const [qr, setQr] = useState<QrData | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [chats, setChats] = useState<ChatItem[]>([]);
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
  const [activeTab, setActiveTab] = useState<"chat" | "webhooks">("chat");

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

  useEffect(() => {
    if (connection?.name && !customName) setCustomName(connection.name);
  }, [connection?.name]);

  const fetchConn = useCallback(async () => {
    try { const d = await apiFetch(`/api/connections/${id}`); mutateConn(d); return d as Connection; }
    catch { return null; }
  }, [id, mutateConn]);

  const fetchQr = useCallback(async () => {
    try {
      const d = await apiFetch(`/api/connections/${id}/qr`);
      if (d.connected) { mutateConn((p: Connection | null) => p ? { ...p, status: "connected" } : p); setQr(null); setQrError(null); return; }
      setQr(d); setQrError(null);
    } catch (err) { setQrError(err instanceof Error ? err.message : "Error al cargar QR"); }
  }, [id, mutateConn]);

  // Poll connection status when pending/scan_qr
  useEffect(() => {
    const t = setInterval(() => {
      const s = connRef.current?.status;
      if (s === "scan_qr" || s === "pending") fetchConn();
    }, 2000);
    return () => clearInterval(t);
  }, [fetchConn]);

  // Poll QR
  useEffect(() => {
    if (!connection) return;
    if (connection.status === "scan_qr" || connection.status === "pending") {
      fetchQr();
      const t = setInterval(fetchQr, 3000);
      return () => clearInterval(t);
    } else { setQr(null); setQrError(null); }
  }, [connection?.status, fetchQr]);

  // Load chats when connected
  useEffect(() => {
    if (connection?.status !== "connected") return;
    Promise.all([
      apiFetch(`/api/connections/${id}/me`).catch(() => null),
      apiFetch(`/api/connections/${id}/chats`).catch(() => []),
    ]).then(([me, chatsData]) => {
      if (me) setProfile(me);
      setChats(chatsData ?? []);
    });
  }, [connection?.status, id]);

  async function handleRestart() {
    setRestarting(true);
    mutateConn((p: Connection | null) => p ? { ...p, status: "scan_qr" } : p);
    setChats([]); setProfile(null); setSelectedChat(null);
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
              <button onClick={handleRestart} disabled={restarting}
                className="flex items-center gap-1.5 rounded-xl border border-border-secondary px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-all disabled:opacity-50">
                <svg className={`h-3.5 w-3.5 ${restarting ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                </svg>
                {restarting ? "Reiniciando…" : "Reiniciar"}
              </button>
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
              {qr ? (
                <div className="rounded-2xl bg-white p-3 shadow-xl">
                  <img src={`data:${qr.mimetype};base64,${qr.value}`} alt="QR Code" className="h-52 w-52 rounded-xl"/>
                </div>
              ) : (
                <div className="flex h-[220px] w-[220px] items-center justify-center rounded-2xl bg-bg-elevated">
                  {qrError ? (
                    <p className="text-xs text-text-tertiary text-center px-4">
                      {qrError.includes("provisioned") || qrError.includes("starting") ? "Iniciando servidor…" : qrError}
                    </p>
                  ) : (
                    <svg className="h-8 w-8 animate-spin text-wa-green" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                      <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
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
            {(["chat", "webhooks"] as const).map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-semibold transition-all border-b-2 -mb-px capitalize
                  ${activeTab === tab
                    ? "border-wa-green text-wa-green"
                    : "border-transparent text-text-tertiary hover:text-text-secondary"}`}>
                {tab === "chat" ? "💬 Chat" : "🔗 Webhooks"}
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
                    {chats.length === 0 ? (
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
