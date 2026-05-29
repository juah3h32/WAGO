"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/api";

interface Chat {
  id: string;
  name?: string;
  timestamp: number;
  lastMessage?: { body: string; timestamp: number; fromMe: boolean };
  unreadCount?: number;
}

interface Message {
  id: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  type?: string;
  hasMedia?: boolean;
  mediaUrl?: string;
}

interface Connection {
  id: string;
  name?: string | null;
  status: string;
}

export default function MessageAlerts() {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedConn, setSelectedConn] = useState<Connection | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const msgsEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load connected connections
  useEffect(() => {
    apiFetch("/api/connections")
      .then((data: any) => {
        const active = (data || []).filter((c: any) => c.status === "connected" || c.status === "working");
        setConnections(active);
        if (active.length === 1 && !selectedConn) setSelectedConn(active[0]);
      })
      .catch(() => {});
  }, []);

  // Load chats when connection selected
  useEffect(() => {
    if (!selectedConn) return;
    setLoadingChats(true);
    setChats([]);
    setSelectedChat(null);
    setMessages([]);
    apiFetch(`/api/connections/${selectedConn.id}/chats`)
      .then((data: any) => setChats(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoadingChats(false));
  }, [selectedConn?.id]);

  // Load messages when chat selected
  const loadMessages = useCallback(async () => {
    if (!selectedConn || !selectedChat) return;
    try {
      const data = await apiFetch(
        `/api/connections/${selectedConn.id}/chats/${encodeURIComponent(selectedChat.id)}/messages`
      );
      setMessages(Array.isArray(data) ? data.slice(-60) : []);
    } catch { /* ignore */ }
  }, [selectedConn?.id, selectedChat?.id]);

  useEffect(() => {
    if (!selectedChat) return;
    setLoadingMsgs(true);
    loadMessages().finally(() => setLoadingMsgs(false));
  }, [selectedChat?.id]);

  // Poll messages every 2.5s when chat open
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!open || !selectedChat) return;
    pollRef.current = setInterval(loadMessages, 2500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, selectedChat?.id, loadMessages]);

  // Scroll to bottom on new messages
  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Background unread counter
  useEffect(() => {
    if (!connections.length || open) return;
    const poll = async () => {
      let count = 0;
      for (const conn of connections) {
        try {
          const data: Chat[] = await apiFetch(`/api/connections/${conn.id}/chats`).catch(() => []);
          if (!Array.isArray(data)) continue;
          for (const chat of data) {
            if (!chat.lastMessage || chat.lastMessage.fromMe) continue;
            const key = `${chat.id}-${chat.lastMessage.timestamp}`;
            if (!seenRef.current.has(key)) { count++; seenRef.current.add(key); }
          }
        } catch (_e) { /* polling — ignore */ }
      }
      if (count > 0) setUnreadTotal((p) => p + count);
      setSyncing(true); setTimeout(() => setSyncing(false), 500);
      setLastSync(new Date());
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [connections, open]);

  const sendMessage = async () => {
    if (!draft.trim() || !selectedConn || !selectedChat || sending) return;
    setSending(true);
    const text = draft.trim();
    setDraft("");
    // Optimistic message
    const optimistic: Message = { id: `opt-${Date.now()}`, body: text, fromMe: true, timestamp: Math.floor(Date.now() / 1000) };
    setMessages((p) => [...p, optimistic]);
    try {
      await apiFetch(`/api/connections/${selectedConn.id}/send`, {
        method: "POST",
        body: JSON.stringify({ chatId: selectedChat.id, text }),
      });
      await loadMessages();
    } catch (e) {
      setMessages((p) => p.filter((m) => m.id !== optimistic.id));
      setDraft(text);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const connectedCount = connections.length;
  const showView = open;

  const formatTime = (ts: number) =>
    new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const chatName = (c: Chat) => c.name || c.id.replace(/@.+/, "");

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => { setOpen(true); setUnreadTotal(0); }}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-3 rounded-2xl bg-bg-secondary border border-border-secondary px-4 py-3 shadow-xl transition-all hover:shadow-2xl hover:border-wa-green/40 hover:scale-[1.02] active:scale-95"
      >
        <div className="relative">
          <svg className={`h-5 w-5 transition-all ${syncing ? "animate-spin text-wa-green" : "text-text-secondary"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
          </svg>
          {connectedCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wa-green opacity-75"/>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-wa-green"/>
            </span>
          )}
        </div>
        <div className="text-left">
          <p className="text-sm font-semibold text-text-primary">Mensajes</p>
          <p className="text-[10px] text-text-tertiary">
            {connectedCount > 0 ? `${connectedCount} conectado${connectedCount > 1 ? "s" : ""}` : "Sin conexión"}
            {lastSync ? ` · ${lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
          </p>
        </div>
        {unreadTotal > 0 && (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-wa-green text-xs font-bold text-text-inverse">
            {unreadTotal > 99 ? "99+" : unreadTotal}
          </span>
        )}
      </button>

      {/* Messenger panel */}
      {showView && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setOpen(false)} />

          {/* Panel */}
          <div className="relative flex h-full w-[760px] max-w-[95vw] shadow-2xl" style={{ animation: "slideInRight 0.2s ease-out" }}>

            {/* LEFT — Chat list */}
            <div className="flex w-64 shrink-0 flex-col border-r border-border-primary bg-bg-secondary">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-border-primary px-4 py-4">
                <div>
                  <h3 className="text-sm font-bold text-text-primary">Mensajes</h3>
                  <p className="text-[10px] text-text-tertiary mt-0.5">{connectedCount} conexión{connectedCount !== 1 ? "es" : ""} activa{connectedCount !== 1 ? "s" : ""}</p>
                </div>
                <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-all">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
              </div>

              {/* Connection selector */}
              {connections.length > 1 && (
                <div className="border-b border-border-primary px-3 py-2 flex gap-1 overflow-x-auto">
                  {connections.map((c) => (
                    <button key={c.id} onClick={() => setSelectedConn(c)}
                      className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${selectedConn?.id === c.id ? "bg-wa-green text-text-inverse" : "text-text-secondary hover:bg-bg-hover"}`}>
                      {c.name || "WhatsApp"}
                    </button>
                  ))}
                </div>
              )}

              {/* Chat list */}
              <div className="flex-1 overflow-y-auto">
                {connectedCount === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full p-6 text-center gap-3">
                    <svg className="h-10 w-10 text-text-tertiary/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
                    <p className="text-xs text-text-tertiary">Sin conexiones activas</p>
                  </div>
                ) : loadingChats ? (
                  <div className="flex items-center justify-center h-20">
                    <svg className="h-5 w-5 animate-spin text-wa-green" fill="none" viewBox="0 0 24 24"><circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  </div>
                ) : chats.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-24 p-4 text-center">
                    <p className="text-xs text-text-tertiary">No hay chats aún</p>
                  </div>
                ) : (
                  chats.map((chat) => (
                    <button key={chat.id} onClick={() => setSelectedChat(chat)}
                      className={`w-full flex items-start gap-3 px-4 py-3 hover:bg-bg-hover transition-all border-b border-border-primary/40 text-left ${selectedChat?.id === chat.id ? "bg-wa-green/10 border-l-2 border-l-wa-green" : ""}`}>
                      {/* Avatar */}
                      <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-full bg-wa-green/20 text-wa-green text-sm font-bold uppercase">
                        {chatName(chat).charAt(0)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1">
                          <p className="text-xs font-semibold text-text-primary truncate">{chatName(chat)}</p>
                          {chat.lastMessage && (
                            <span className="shrink-0 text-[10px] text-text-tertiary tabular-nums">
                              {formatTime(chat.lastMessage.timestamp)}
                            </span>
                          )}
                        </div>
                        {chat.lastMessage && (
                          <p className={`mt-0.5 text-[11px] truncate ${chat.lastMessage.fromMe ? "text-text-tertiary" : "text-text-secondary"}`}>
                            {chat.lastMessage.fromMe ? "Tú: " : ""}{chat.lastMessage.body}
                          </p>
                        )}
                      </div>
                      {chat.unreadCount && chat.unreadCount > 0 && !chat.lastMessage?.fromMe && (
                        <span className="shrink-0 flex h-5 min-w-5 items-center justify-center rounded-full bg-wa-green text-[10px] font-bold text-text-inverse px-1">
                          {chat.unreadCount}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* RIGHT — Conversation */}
            <div className="flex flex-1 flex-col bg-bg-primary">
              {!selectedChat ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border-primary bg-bg-elevated">
                    <svg className="h-8 w-8 text-text-tertiary/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
                  </div>
                  <p className="text-sm text-text-tertiary">Seleccioná un chat para ver la conversación</p>
                </div>
              ) : (
                <>
                  {/* Chat header */}
                  <div className="flex items-center gap-3 border-b border-border-primary px-5 py-3.5">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-wa-green/20 text-wa-green text-sm font-bold uppercase shrink-0">
                      {chatName(selectedChat).charAt(0)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-text-primary truncate">{chatName(selectedChat)}</p>
                      <p className="text-[10px] text-text-tertiary">{selectedConn?.name || "WhatsApp"}</p>
                    </div>
                    <button onClick={() => setSelectedChat(null)} className="rounded-lg p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-all">
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/></svg>
                    </button>
                  </div>

                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
                    {loadingMsgs ? (
                      <div className="flex items-center justify-center h-20">
                        <svg className="h-5 w-5 animate-spin text-wa-green" fill="none" viewBox="0 0 24 24"><circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                      </div>
                    ) : messages.length === 0 ? (
                      <div className="flex items-center justify-center h-20">
                        <p className="text-xs text-text-tertiary">No hay mensajes</p>
                      </div>
                    ) : (
                      messages.map((msg) => (
                        <div key={msg.id} className={`flex ${msg.fromMe ? "justify-end" : "justify-start"}`}>
                          <div className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed ${
                            msg.fromMe
                              ? "bg-wa-green text-text-inverse rounded-br-sm"
                              : "bg-bg-secondary border border-border-primary text-text-primary rounded-bl-sm"
                          }`}>
                            <p className="whitespace-pre-wrap break-words">{msg.body || (msg.hasMedia ? "📎 Archivo" : "")}</p>
                            <p className={`mt-1 text-[10px] text-right ${msg.fromMe ? "text-text-inverse/60" : "text-text-tertiary"}`}>
                              {formatTime(msg.timestamp)}
                            </p>
                          </div>
                        </div>
                      ))
                    )}
                    <div ref={msgsEndRef} />
                  </div>

                  {/* Reply box */}
                  <div className="border-t border-border-primary px-4 py-3">
                    <div className="flex items-end gap-2">
                      <textarea
                        ref={textareaRef}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={handleKey}
                        placeholder="Escribí un mensaje… (Enter para enviar)"
                        rows={1}
                        className="flex-1 resize-none rounded-xl border border-border-primary bg-bg-secondary px-3.5 py-2.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none transition-colors"
                        style={{ maxHeight: "96px", overflowY: "auto" }}
                      />
                      <button
                        onClick={sendMessage}
                        disabled={!draft.trim() || sending}
                        className="shrink-0 flex h-9 w-9 items-center justify-center rounded-xl bg-wa-green text-text-inverse disabled:opacity-40 hover:bg-wa-green-dark transition-all"
                      >
                        {sending ? (
                          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                        ) : (
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
                        )}
                      </button>
                    </div>
                    <p className="mt-1.5 text-[10px] text-text-tertiary">Shift+Enter para salto de línea</p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </>
  );
}
