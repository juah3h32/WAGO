"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/api";

interface ChatMessage {
  id: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  chatId: string;
  senderName?: string;
}

interface Alert {
  id: string;
  chatId: string;
  chatName: string;
  message: string;
  timestamp: number;
  connectionName: string;
  isNew: boolean;
}

export default function MessageAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [showPanel, setShowPanel] = useState(false);
  const [connections, setConnections] = useState<any[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const [unreadCount, setUnreadCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  useEffect(() => {
    apiFetch("/api/connections")
      .then((data: any) => {
        setConnections((data || []).filter((c: any) => c.status === "working" || c.status === "connected"));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (connections.length === 0) return;

    const poll = async () => {
      let hasNew = false;
      for (const conn of connections) {
        try {
          const chats: any[] = await apiFetch(`/api/connections/${conn.id}/chats`).catch(() => []);
          if (!Array.isArray(chats)) continue;
          for (const chat of chats) {
            if (!chat.lastMessage || chat.lastMessage.fromMe) continue;
            const msgId = `${chat.id}-${chat.lastMessage.timestamp}`;
            if (seenRef.current.has(msgId)) continue;
            seenRef.current.add(msgId);
            hasNew = true;
            const newAlert: Alert = {
              id: msgId, chatId: chat.id,
              chatName: chat.name || chat.id.replace("@c.us", ""),
              message: chat.lastMessage.body?.slice(0, 120) || "",
              timestamp: chat.lastMessage.timestamp,
              connectionName: conn.name || "WhatsApp",
              isNew: true,
            };
            setAlerts((prev) => [newAlert, ...prev].slice(0, 100));
            if (!showPanel) setUnreadCount((c) => c + 1);
          }
        } catch {}
      }
      if (hasNew) {
        setSyncing(true);
        setTimeout(() => setSyncing(false), 600);
      }
      setLastSync(new Date());
    };

    poll();
    const interval = setInterval(poll, 2500);
    return () => clearInterval(interval);
  }, [connections, showPanel]);

  // Fade out "isNew" after animation
  useEffect(() => {
    const timer = setTimeout(() => {
      setAlerts((prev) => prev.map((a) => ({ ...a, isNew: false })));
    }, 2000);
    return () => clearTimeout(timer);
  }, [alerts.length]);

  const dismiss = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const connectedCount = connections.length;

  return (
    <>
      {/* Floating button — bottom-right to avoid covering the sidebar sign-out button */}
      <button onClick={() => { setShowPanel(true); setUnreadCount(0); }}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-2xl bg-bg-secondary border border-border-secondary px-4 py-3 shadow-xl transition-all hover:shadow-2xl hover:border-wa-green/30 hover:scale-[1.02] active:scale-95">
        <div className="relative">
          <svg className={`h-5 w-5 text-text-secondary transition-all ${syncing ? "animate-spin text-wa-green" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
          </svg>
          {connectedCount > 0 && <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wa-green opacity-75"/><span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-wa-green"/></span>}
        </div>
        <div className="text-left">
          <p className="text-sm font-semibold text-text-primary">Mensajes</p>
          <p className="text-[10px] text-text-tertiary">{connectedCount > 0 ? `${connectedCount} conectado${connectedCount > 1 ? "s" : ""}` : "Sin conexión"}{lastSync ? ` · ${lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</p>
        </div>
        {unreadCount > 0 && (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-wa-green text-xs font-bold text-text-inverse animate-in">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Slide panel — opens from the right */}
      {showPanel && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="w-80 shrink-0 border-l border-border-primary bg-bg-secondary flex flex-col animate-slide-right shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border-primary px-5 py-4">
              <div>
                <h3 className="text-sm font-bold text-text-primary">Mensajes</h3>
                <p className="text-[10px] text-text-tertiary mt-0.5">{alerts.length} mensajes · {connectedCount} activo{connectedCount !== 1 && "s"}</p>
              </div>
              <button onClick={() => setShowPanel(false)} className="rounded-lg p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-all">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto">
              {alerts.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full p-6 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border-primary bg-bg-elevated">
                    <svg className="h-8 w-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
                  </div>
                  <p className="mt-4 text-sm text-text-tertiary">No hay mensajes</p>
                  <p className="text-xs text-text-tertiary/60 mt-1">Esperando nuevos mensajes...</p>
                </div>
              ) : (
                alerts.map((alert) => (
                  <div key={alert.id}
                    className={`group border-b border-border-primary/50 px-5 py-3.5 hover:bg-bg-elevated transition-all cursor-pointer ${alert.isNew ? "bg-wa-green/5 border-l-2 border-l-wa-green" : ""}`}
                    onClick={() => dismiss(alert.id)}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-semibold text-text-primary truncate">{alert.chatName}</p>
                      <span className="shrink-0 text-[10px] text-text-tertiary tabular-nums">
                        {new Date(alert.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary leading-relaxed line-clamp-2">{alert.message}</p>
                    <p className="mt-1.5 text-[10px] text-text-tertiary/70">{alert.connectionName}</p>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="absolute inset-0 -z-10" onClick={() => setShowPanel(false)} />
        </div>
      )}
    </>
  );
}
