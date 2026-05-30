"use client";

import { useState, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { useToast } from "@/components/toast";
import { StatusBadge } from "@/components/status-badge";
import { ConnectionListSkeleton } from "@/components/skeletons";
import DashboardProviders from "@/components/DashboardProviders";

interface Connection {
  id: string;
  name: string | null;
  phoneNumber: string | null;
  status: string;
  createdAt: string;
}
interface QrData { value: string; mimetype: string; }

export default function ConnectionsPage() {
  return <DashboardProviders><ConnectionsPageContent /></DashboardProviders>;
}

function statFor(list: Connection[], status: string) {
  return list.filter((c) => c.status === status).length;
}

function ConnectionsPageContent() {
  const { data: connections, loading, error, mutate } = useApiData<Connection[]>(
    "connections",
    () => apiFetch("/api/connections"),
    { revalidateInterval: 5_000 }   // real-time status updates
  );
  const list = connections ?? [];
  const { toast } = useToast();

  const [deleteTarget, setDeleteTarget] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [newConnId, setNewConnId] = useState<string | null>(null);
  const [qr, setQr] = useState<QrData | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  // ── Quick-send test modal ─────────────────────────────────────────────────
  const [sendTarget, setSendTarget] = useState<Connection | null>(null);
  const [sendChatId, setSendChatId] = useState("");
  const [sendMsg, setSendMsg] = useState("");
  const [sendingTest, setSendingTest] = useState(false);

  async function handleTestSend(e: React.FormEvent) {
    e.preventDefault();
    if (!sendTarget || !sendChatId.trim() || !sendMsg.trim()) return;
    setSendingTest(true);
    try {
      await apiFetch(`/api/connections/${sendTarget.id}/send`, {
        method: "POST",
        body: JSON.stringify({ chatId: sendChatId.trim(), text: sendMsg.trim() }),
      });
      toast("Mensaje enviado ✓", "success");
      setSendTarget(null);
      setSendChatId("");
      setSendMsg("");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Error al enviar", "error");
    } finally {
      setSendingTest(false);
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const prev = list;
    mutate((p) => p ? p.filter((c) => c.id !== deleteTarget.id) : p);
    setDeleteTarget(null);
    try {
      await apiFetch(`/api/connections/${deleteTarget.id}`, { method: "DELETE" });
      toast("Conexión eliminada", "success");
    } catch {
      mutate(prev);
      toast("Error al eliminar", "error");
    } finally { setDeleting(false); }
  }, [deleteTarget, list, mutate, toast]);

  // ── QR poll ───────────────────────────────────────────────────────────────
  // useEffect for QR poll
  const [qrPollActive, setQrPollActive] = useState(false);

  function closeModal() {
    setShowModal(false);
    setNewConnId(null);
    setNewName("");
    setQr(null);
    setModalError(null);
    setQrPollActive(false);
  }

  const handleCreate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setModalError(null);
    try {
      const conn = await apiFetch("/api/connections", {
        method: "POST",
        body: JSON.stringify({ name: newName || undefined }),
      });
      setNewConnId(conn.id);
      setQrPollActive(true);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Error al crear");
    } finally { setCreating(false); }
  }, [newName]);

  // Poll QR when newConnId is set
  const [_qrInterval, setQrInterval] = useState<any>(null);

  function startQrPolling(connId: string) {
    const poll = async () => {
      setQrLoading(true);
      try {
        const data = await apiFetch(`/api/connections/${connId}/qr`);
        if (data.connected) { closeModal(); mutate(); }
        else if (data.value) { setQr(data); setModalError(null); }
      } catch (err: any) {
        const msg = err?.message || "";
        if (!msg.includes("starting up") && !msg.includes("provisioned")) setModalError(msg);
      } finally { setQrLoading(false); }
    };
    poll();
    const t = setInterval(poll, 2500);
    setQrInterval(t);
    return t;
  }

  // Stats
  const connected = statFor(list, "connected");
  const pending = statFor(list, "pending") + statFor(list, "scan_qr");
  const failed = statFor(list, "failed");

  return (
    <div className="animate-fade-in space-y-6">
      {/* ── Header ── */}
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
          <button
            onClick={() => setShowModal(true)}
            className="flex shrink-0 items-center gap-2 rounded-xl bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
            </svg>
            Nueva
          </button>
        )}
      </div>

      {/* ── Stats (only with data) ── */}
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
          Error al cargar conexiones: {error}
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && !error && list.length === 0 && !showModal && (
        <div className="flex min-h-[65vh] items-center justify-center">
          <div className="flex max-w-sm flex-col items-center text-center w-full">
            <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-wa-green/10 mb-6">
              <svg className="h-12 w-12 text-wa-green" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-text-primary">Sin conexiones</h2>
            <p className="mt-3 text-sm text-text-secondary leading-relaxed">
              Conectá tu WhatsApp y empezá a gestionar mensajes, webhooks y automatizaciones desde la API.
            </p>
            <button
              onClick={() => setShowModal(true)}
              className="mt-8 w-full rounded-2xl bg-wa-green px-6 py-3.5 text-sm font-bold text-text-inverse hover:bg-wa-green-dark transition-all hover:shadow-xl hover:shadow-wa-green/25 flex items-center justify-center gap-2"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
              </svg>
              Crear primera conexión
            </button>
          </div>
        </div>
      )}

      {/* ── Connection list ── */}
      {!loading && !error && list.length > 0 && (
        <div className="space-y-2">
          {list.map((conn) => (
            <ConnectionCard
              key={conn.id}
              conn={conn}
              onDelete={() => setDeleteTarget(conn)}
              onQuickSend={() => { setSendTarget(conn); setSendChatId(""); setSendMsg(""); }}
            />
          ))}
        </div>
      )}

      {/* ── Delete modal ── */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => !deleting && setDeleteTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-3xl border border-border-secondary bg-bg-secondary p-6 shadow-2xl animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-status-error-bg">
              <svg className="h-6 w-6 text-status-error-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            </div>
            <h3 className="text-center text-lg font-bold text-text-primary">Eliminar conexión</h3>
            <p className="mt-1 text-center text-sm text-text-secondary">
              "{deleteTarget.name || deleteTarget.phoneNumber ? `+${deleteTarget.phoneNumber}` : "Conexión"}" se eliminará permanentemente.
            </p>
            <div className="mt-5 flex gap-2">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                className="flex-1 rounded-xl border border-border-secondary px-4 py-2.5 text-sm font-semibold text-text-secondary hover:bg-bg-hover transition-all disabled:opacity-50">
                Cancelar
              </button>
              <button onClick={handleDelete} disabled={deleting}
                className="flex-1 rounded-xl bg-status-error-text px-4 py-2.5 text-sm font-bold text-white hover:opacity-90 transition-all disabled:opacity-50">
                {deleting ? "Eliminando…" : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Quick send modal ── */}
      {sendTarget && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => !sendingTest && setSendTarget(null)}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-border-secondary bg-bg-secondary shadow-2xl animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 pt-6 pb-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-wa-green/15">
                  <svg className="h-5 w-5 text-wa-green" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-base font-bold text-text-primary">Envío rápido</h2>
                  <p className="text-xs text-text-tertiary">
                    {sendTarget.name || (sendTarget.phoneNumber ? `+${sendTarget.phoneNumber}` : "Conexión")}
                  </p>
                </div>
              </div>
              <button onClick={() => setSendTarget(null)} disabled={sendingTest}
                className="rounded-xl p-2 text-text-tertiary hover:bg-bg-elevated hover:text-text-primary transition-all">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <form onSubmit={handleTestSend} className="px-6 pb-6 space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-secondary">
                  Número destino
                </label>
                <input
                  type="text"
                  value={sendChatId}
                  onChange={(e) => setSendChatId(e.target.value)}
                  placeholder="521234567890@c.us  o  52XXXXXXXXXX"
                  autoFocus
                  className="block w-full rounded-xl border border-border-secondary bg-bg-input px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-2 focus:ring-wa-green/20 transition-all font-mono"
                />
                <p className="mt-1.5 text-xs text-text-tertiary">Formato: código país + número, sin +. Ej: 5215512345678</p>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-secondary">Mensaje</label>
                <textarea
                  value={sendMsg}
                  onChange={(e) => setSendMsg(e.target.value)}
                  placeholder="Escribe el mensaje de prueba…"
                  rows={3}
                  style={{ resize: "none" }}
                  className="block w-full rounded-xl border border-border-secondary bg-bg-input px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-2 focus:ring-wa-green/20 transition-all"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={sendingTest || !sendChatId.trim() || !sendMsg.trim()}
                  className="flex-1 rounded-xl bg-wa-green py-3 text-sm font-bold text-text-inverse hover:bg-wa-green-dark transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {sendingTest ? (
                    <><svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Enviando…</>
                  ) : "Enviar mensaje"}
                </button>
                <button type="button" onClick={() => setSendTarget(null)} disabled={sendingTest}
                  className="rounded-xl border border-border-secondary px-5 py-3 text-sm font-medium text-text-secondary hover:bg-bg-hover transition-all disabled:opacity-50">
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── New connection modal ── */}
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
            <div className="flex items-center justify-between px-6 pt-6 pb-2">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-wa-green/15">
                  <svg className="h-5 w-5 text-wa-green" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                </div>
                <h2 className="text-lg font-bold text-text-primary">
                  {qr ? "Escanear código QR" : newConnId ? "Preparando WhatsApp…" : "Nueva conexión"}
                </h2>
              </div>
              <button onClick={closeModal}
                className="rounded-xl p-2 text-text-tertiary hover:bg-bg-elevated hover:text-text-primary transition-all">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <div className="px-6 pb-6 pt-4">
              {!newConnId && (
                <form onSubmit={handleCreate} className="space-y-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">
                      Nombre <span className="text-text-tertiary font-normal">(opcional)</span>
                    </label>
                    <input
                      type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                      placeholder="ej. WhatsApp Principal, Ventas, Soporte"
                      disabled={creating} autoFocus
                      className="block w-full rounded-xl border border-border-secondary bg-bg-input px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-2 focus:ring-wa-green/20 transition-all disabled:opacity-50"
                    />
                  </div>
                  {modalError && (
                    <p className="rounded-xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text">
                      {modalError}
                    </p>
                  )}
                  <button type="submit" disabled={creating}
                    className="w-full rounded-xl bg-wa-green py-3 text-sm font-bold text-text-inverse hover:bg-wa-green-dark transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                    {creating
                      ? <><svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Creando…</>
                      : "Crear conexión"}
                  </button>
                </form>
              )}

              {newConnId && !qr && (
                <div className="flex flex-col items-center py-12">
                  <div className="relative">
                    <div className="h-16 w-16 rounded-full border-2 border-wa-green/20" />
                    <svg className="absolute inset-0 h-16 w-16 animate-spin text-wa-green" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                      <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                  </div>
                  <p className="mt-5 text-sm font-semibold text-text-primary">
                    {qrLoading ? "Generando código QR…" : "Iniciando servidor…"}
                  </p>
                  <p className="mt-1 text-xs text-text-tertiary">Esto puede tardar unos segundos</p>
                </div>
              )}

              {qr && (
                <div className="flex flex-col items-center">
                  <div className="rounded-2xl bg-white p-3 shadow-lg">
                    <img src={`data:${qr.mimetype};base64,${qr.value}`} alt="QR WhatsApp" className="h-56 w-56 rounded-xl"/>
                  </div>
                  <div className="mt-5 rounded-xl bg-bg-elevated px-4 py-3 text-sm text-text-secondary max-w-xs text-center">
                    <p>Abrí <strong className="text-text-primary">WhatsApp</strong> → Dispositivos vinculados → Vincular dispositivo y escaneá el código</p>
                  </div>
                  {modalError && <p className="mt-3 text-xs text-status-error-text">{modalError}</p>}
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

function ConnectionCard({
  conn,
  onDelete,
  onQuickSend,
}: {
  conn: Connection;
  onDelete: () => void;
  onQuickSend: () => void;
}) {
  const isConnected = conn.status === "connected";
  const label = conn.name || (conn.phoneNumber ? `+${conn.phoneNumber}` : "Sin nombre");
  const sub = conn.name && conn.phoneNumber ? `+${conn.phoneNumber}` : conn.id.slice(0, 20) + "…";

  return (
    <div className="group relative flex items-center gap-4 rounded-2xl border border-border-primary bg-bg-secondary px-5 py-4 hover:border-border-secondary hover:bg-bg-elevated transition-all duration-150">
      {/* Avatar */}
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-base font-bold text-text-secondary border border-border-primary">
        {(conn.name?.[0] || conn.phoneNumber?.[0] || "W").toUpperCase()}
      </div>

      {/* Info */}
      <a href={`/dashboard/connections/${conn.id}`} className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-semibold text-text-primary">{label}</p>
          <StatusBadge status={conn.status} />
        </div>
        <p className="mt-0.5 text-xs text-text-tertiary font-mono truncate">{sub}</p>
      </a>

      {/* Actions */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {/* Quick send (only when connected) */}
        {isConnected && (
          <button
            onClick={onQuickSend}
            title="Envío rápido"
            className="rounded-lg p-2 text-text-tertiary hover:bg-wa-green/10 hover:text-wa-green transition-all"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        )}

        {/* Go to detail */}
        <a
          href={`/dashboard/connections/${conn.id}`}
          title="Ver detalle"
          className="rounded-lg p-2 text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-all"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
        </a>

        {/* Delete */}
        <button
          onClick={onDelete}
          title="Eliminar"
          className="rounded-lg p-2 text-text-tertiary hover:bg-status-error-bg hover:text-status-error-text transition-all"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
