"use client";

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { useApiData } from "@/lib/cache";
import { useToast } from "@/components/toast";
import { StatusBadge } from "@/components/status-badge";
import { ConnectionListSkeleton } from "@/components/skeletons";

interface Connection {
  id: string;
  name: string | null;
  phoneNumber: string | null;
  status: string;
}

interface QrData {
  value: string;
  mimetype: string;
}

export default function ConnectionsPage() {
  const {
    data: connections,
    loading,
    error,
    mutate,
  } = useApiData<Connection[]>("connections", () =>
    apiFetch("/api/connections")
  );

  const list = connections ?? [];

  const [phoneNumbers, setPhoneNumbers] = useState<Record<string, string>>({});
  useEffect(() => {
    if (list.length === 0) return;
    const working = list.filter((c) => c.status === "connected" && !c.phoneNumber);
    if (working.length === 0) return;
    Promise.all(
      working.map((c) =>
        apiFetch(`/api/connections/${c.id}/me`)
          .then((me: any) => ({ id: c.id, phone: me?.id?.replace("@c.us", "") || null }))
          .catch(() => ({ id: c.id, phone: null }))
      )
    ).then((results) => {
      const phones: Record<string, string> = {};
      for (const r of results) {
        if (r.phone) phones[r.id] = r.phone;
      }
      setPhoneNumbers(phones);
    });
  }, [list]);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [newConnId, setNewConnId] = useState<string | null>(null);
  const [qr, setQr] = useState<QrData | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const { toast } = useToast();
  const [deleteTarget, setDeleteTarget] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    // Optimistic: remove immediately
    const prevList = list;
    mutate((prev) => (prev ? prev.filter((c) => c.id !== deleteTarget.id) : prev));
    setDeleteTarget(null);
    try {
      await apiFetch(`/api/connections/${deleteTarget.id}`, { method: "DELETE" });
      toast("Conexión eliminada", "success");
    } catch {
      mutate(prevList);
      toast("Error al eliminar", "error");
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, list, mutate, toast]);

  // Poll QR code when connection is created
  useEffect(() => {
    if (!newConnId) return;
    let cancelled = false;

    async function pollQr() {
      setQrLoading(true);
      try {
        const data = await apiFetch(`/api/connections/${newConnId}/qr`);
        if (cancelled) return;
        if (data.connected) {
          setQr(null);
          setShowModal(false);
          setNewConnId(null);
          setNewName("");
          mutate();
        } else if (data.value) {
          setQr(data);
          setModalError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          const msg = err?.message || "Error loading QR";
          if (msg.includes("starting up") || msg.includes("being provisioned")) {
            // Worker is booting, keep polling
          } else {
            setModalError(msg);
          }
        }
      } finally {
        if (!cancelled) setQrLoading(false);
      }
    }

    pollQr();
    const interval = setInterval(pollQr, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [newConnId, mutate]);

  // Poll connection status when we have a QR — checks DB for faster close
  useEffect(() => {
    if (!newConnId || !qr) return;
    const check = async () => {
      try {
        const conn = await apiFetch(`/api/connections/${newConnId}`);
        if (conn.status === "connected" || conn.status === "working") {
          setQr(null);
          setShowModal(false);
          setNewConnId(null);
          setNewName("");
          mutate();
        }
      } catch {}
    };
    const interval = setInterval(check, 2000);
    return () => clearInterval(interval);
  }, [newConnId, qr, mutate]);

  // Auto-close modal after 3 minutes (failsafe)
  useEffect(() => {
    if (!newConnId || !qr) return;
    const timer = setTimeout(() => {
      setQr(null);
      setShowModal(false);
      setNewConnId(null);
      setNewName("");
      mutate();
    }, 180000);
    return () => clearTimeout(timer);
  }, [newConnId, qr, mutate]);

  const handleCreate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setModalError(null);
    try {
      const connection = await apiFetch("/api/connections", {
        method: "POST",
        body: JSON.stringify({ name: newName || undefined }),
      });
      setNewConnId(connection.id);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Failed to create connection");
    } finally {
      setCreating(false);
    }
  }, [newName]);

  function closeModal() {
    setShowModal(false);
    setNewConnId(null);
    setNewName("");
    setQr(null);
    setModalError(null);
  }

  return (
    <div className="animate-fade-in">
      {list.length > 0 && (
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-text-primary">Connections</h1>
          <button onClick={() => setShowModal(true)}
            className="rounded-xl bg-wa-green px-4 py-2.5 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20 flex items-center gap-2">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>
            Nueva Conexión
          </button>
        </div>
      )}

      {loading && <ConnectionListSkeleton />}

      {error && (
        <div className="mt-6 rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">
          Error al cargar conexiones: {error}
        </div>
      )}

      {!loading && !error && list.length === 0 && !showModal && (
        <div className="flex items-center justify-center min-h-[70vh]">
          <div className="flex flex-col items-center text-center rounded-3xl border border-border-primary bg-bg-secondary p-12 max-w-md w-full">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-wa-green/10">
              <svg className="h-10 w-10 text-wa-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
              </svg>
            </div>
            <h2 className="mt-6 text-xl font-bold text-text-primary">Sin conexiones</h2>
            <p className="mt-2 text-sm text-text-secondary leading-relaxed">Creá tu primera conexión de WhatsApp y empezá a recibir mensajes al instante.</p>
            <button onClick={() => setShowModal(true)}
              className="mt-8 w-full rounded-xl bg-wa-green px-6 py-3.5 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20 flex items-center justify-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>
              Crear conexión
            </button>
          </div>
        </div>
      )}

      {!loading && !error && list.length > 0 && (
        <div className="mt-6 space-y-2">
          {list.map((conn) => (
            <div key={conn.id} className="group relative flex items-center justify-between rounded-xl border border-border-primary bg-bg-secondary px-5 py-4 transition-all duration-150 hover:border-border-secondary hover:bg-bg-elevated">
              <a href={`/dashboard/connections/${conn.id}`} className="min-w-0 flex-1 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-text-primary">
                    {conn.name || "Conexión sin nombre"}
                  </p>
                  <p className="mt-0.5 text-xs text-text-tertiary">
                    {conn.phoneNumber
                      ? `+${conn.phoneNumber}`
                      : phoneNumbers[conn.id]
                        ? `+${phoneNumbers[conn.id]}`
                        : conn.status === "connected"
                          ? "Cargando..."
                          : "Sin número vinculado"}
                  </p>
                </div>
                <StatusBadge status={conn.status} />
                <svg className="h-4 w-4 text-text-tertiary transition-colors duration-150 group-hover:text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </a>
              <button
                onClick={(e) => { e.preventDefault(); setDeleteTarget(conn); }}
                className="ml-3 shrink-0 rounded-lg p-2 text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-400 transition-all"
                title="Eliminar conexión"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-border-secondary bg-bg-secondary p-8 shadow-2xl text-center" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10">
              <svg className="h-7 w-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </div>
            <h3 className="mt-4 text-lg font-bold text-text-primary">Eliminar conexión</h3>
            <p className="mt-2 text-sm text-text-secondary">¿Estás seguro? Esta acción no se puede deshacer.</p>
            <p className="mt-1 text-xs text-text-tertiary truncate">{deleteTarget.name || "Conexión sin nombre"}</p>
            <div className="mt-6 flex gap-3">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} className="flex-1 rounded-xl border border-border-secondary px-4 py-2.5 text-sm font-medium text-text-secondary hover:bg-bg-hover transition-all disabled:opacity-50">Cancelar</button>
              <button onClick={handleDelete} disabled={deleting} className="flex-1 rounded-xl bg-red-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-600 transition-all disabled:opacity-50">
                {deleting ? "Eliminando..." : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal for new connection + QR */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={closeModal}>
          <div className="w-full max-w-md rounded-3xl border border-border-secondary bg-bg-secondary shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-8 pt-8 pb-4">
              <h2 className="text-xl font-bold text-text-primary">
                {qr ? "Escaneá el QR" : newConnId ? "Configurando WhatsApp..." : "Nueva Conexión"}
              </h2>
              <button onClick={closeModal} className="rounded-xl p-2 text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-all">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-8 pb-8">
            {!newConnId && (
              <form onSubmit={handleCreate} className="space-y-5">
                <div>
                  <label htmlFor="conn-name" className="mb-2 block text-sm font-medium text-text-secondary">Nombre <span className="font-normal text-text-tertiary">(opcional)</span></label>
                  <input id="conn-name" type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                    placeholder="ej. Mi WhatsApp Business" disabled={creating} autoFocus
                    className="block w-full rounded-xl border border-border-secondary bg-bg-elevated px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-2 focus:ring-wa-green/20 transition-all disabled:opacity-50"/>
                </div>
                {modalError && (
                  <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-400">{modalError}</div>
                )}
                <button type="submit" disabled={creating}
                  className="w-full rounded-xl bg-wa-green px-4 py-3 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20 disabled:opacity-50 flex items-center justify-center gap-2">
                  {creating ? (
                    <><svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Creando...</>
                  ) : "Crear Conexión"}
                </button>
              </form>
            )}

            {newConnId && !qr && (
              <div className="flex flex-col items-center py-10">
                <svg className="h-10 w-10 animate-spin text-wa-green" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                <p className="mt-4 text-sm font-medium text-text-secondary">{qrLoading ? "Generando código QR..." : "Iniciando worker..."}</p>
                <p className="mt-1 text-xs text-text-tertiary">Esto puede tomar unos segundos</p>
              </div>
            )}

            {qr && (
              <div className="flex flex-col items-center">
                <div className="rounded-2xl border-2 border-wa-green/30 p-2">
                  <img src={`data:${qr.mimetype};base64,${qr.value}`} alt="WhatsApp QR Code" className="h-56 w-56 rounded-xl"/>
                </div>
                <p className="mt-4 text-sm text-text-secondary flex items-center gap-2">
                  <svg className="h-4 w-4 text-wa-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"/></svg>
                  Abrí WhatsApp y escaneá el código
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
