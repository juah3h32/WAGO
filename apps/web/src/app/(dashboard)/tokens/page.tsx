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
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

interface CreatedToken {
  id: string;
  name: string;
  prefix: string;
  token: string;
}

export default function TokensPage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const { data: tokens, loading, error, mutate } = useApiData<ApiToken[]>("tokens", () =>
    apiFetch("/api/tokens")
  );

  const list = tokens ?? [];
  const [showModal, setShowModal] = useState(false);
  const [formName, setFormName] = useState("");
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [newlyCreated, setNewlyCreated] = useState<CreatedToken | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim()) return;
    setFormSubmitting(true);

    const tempId = "temp-" + Math.random().toString(36).slice(2, 9);
    mutate((prev) => (prev ? [{ id: tempId, name: formName.trim(), prefix: "wh_...", lastUsedAt: null, createdAt: new Date().toISOString() }, ...prev] : prev));

    try {
      const created = await apiFetch("/api/tokens", { method: "POST", body: JSON.stringify({ name: formName.trim() }) });
      mutate((prev) => prev ? prev.map((t) => t.id === tempId ? { id: created.id, name: created.name, prefix: created.prefix, lastUsedAt: null, createdAt: created.createdAt ?? new Date().toISOString() } : t) : prev);
      setNewlyCreated(created);
      setFormName("");
      setShowModal(false);
    } catch (err) {
      mutate((prev) => (prev ? prev.filter((t) => t.id !== tempId) : prev));
      toast(err instanceof Error ? err.message : "Failed to create token", "error");
    } finally {
      setFormSubmitting(false);
    }
  }

  async function handleRevoke(tokenId: string) {
    const ok = await confirm({ title: "Revoke token", message: "This action cannot be undone.", confirmLabel: "Revoke", destructive: true });
    if (!ok) return;
    const prev = list;
    mutate(list.filter((t) => t.id !== tokenId));
    try {
      await apiFetch(`/api/tokens/${tokenId}`, { method: "DELETE" });
      toast("Token revoked", "success");
    } catch (err) {
      mutate(prev);
      toast(err instanceof Error ? err.message : "Failed", "error");
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">API Tokens</h1>
          <p className="mt-1 text-sm text-text-secondary">Manage tokens for programmatic API access.</p>
        </div>
        <button onClick={() => setShowModal(true)} className="rounded-xl bg-wa-green px-5 py-2.5 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20">
          <span className="flex items-center gap-2">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>
            Create Token
          </span>
        </button>
      </div>

      {/* Token created warning */}
      {newlyCreated && (
        <div className="mt-6 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 backdrop-blur-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
              <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-amber-400">Save your token now — it won't be shown again</p>
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 break-all rounded-xl bg-bg-elevated px-4 py-2.5 text-sm text-text-primary font-mono border border-border-secondary">{newlyCreated.token}</code>
                <CopyButton text={newlyCreated.token} />
              </div>
              <button onClick={() => { setNewlyCreated(null); setShowModal(false); }} className="mt-3 text-sm text-amber-400/80 hover:text-amber-400 transition-colors">I've saved my token</button>
            </div>
          </div>
        </div>
      )}

      {error && <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">{error}</div>}
      {loading && <TokenListSkeleton />}

      {!loading && !error && list.length === 0 && !newlyCreated && (
        <div className="mt-20 flex flex-col items-center text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-border-primary bg-bg-secondary">
            <svg className="h-10 w-10 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>
          </div>
          <p className="mt-5 text-base font-medium text-text-primary">No API tokens yet</p>
          <p className="mt-1 text-sm text-text-secondary">Create one to access the API programmatically.</p>
          <button onClick={() => setShowModal(true)} className="mt-6 rounded-xl bg-wa-green px-6 py-2.5 text-sm font-semibold text-text-inverse hover:bg-wa-green-dark transition-colors">Create your first token</button>
        </div>
      )}

      {list.length > 0 && (
        <div className="mt-6 space-y-2">
          {list.map((token) => (
            <div key={token.id} className="group flex items-center justify-between rounded-2xl border border-border-primary bg-bg-secondary px-6 py-4 transition-all hover:border-border-secondary hover:bg-bg-elevated">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <p className="font-medium text-text-primary">{token.name}</p>
                  <span className="font-mono text-xs text-text-tertiary bg-bg-elevated px-2 py-0.5 rounded-md border border-border-primary">{token.prefix}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-4 text-xs text-text-tertiary">
                  <span>Created {new Date(token.createdAt).toLocaleDateString()}</span>
                  <span className="w-1 h-1 rounded-full bg-text-tertiary/30" />
                  <span>{token.lastUsedAt ? `Last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : "Never used"}</span>
                </div>
              </div>
              <button onClick={() => handleRevoke(token.id)} className="shrink-0 rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-medium text-red-400 opacity-0 group-hover:opacity-100 transition-all hover:bg-red-500/10">Revoke</button>
            </div>
          ))}
        </div>
      )}

      {/* Create Token Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => { if (!formSubmitting) { setShowModal(false); setFormName(""); } }}>
          <div className="w-full max-w-lg rounded-3xl border border-border-secondary bg-bg-secondary shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-8 pt-8 pb-4">
              <div>
                <h2 className="text-xl font-bold text-text-primary">Create API Token</h2>
                <p className="mt-1 text-sm text-text-secondary">Generate a token to access the WAGO API.</p>
              </div>
              <button onClick={() => { setShowModal(false); setFormName(""); }} className="rounded-xl p-2 text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-all">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>

            {/* Body */}
            <form onSubmit={handleCreate} className="px-8 pb-8 space-y-5">
              <div>
                <label htmlFor="token-name" className="mb-2 block text-sm font-medium text-text-secondary">Token name</label>
                <input id="token-name" type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Production CLI, CI/CD Pipeline" disabled={formSubmitting} autoFocus
                  className="block w-full rounded-xl border border-border-secondary bg-bg-elevated px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-2 focus:ring-wa-green/20 transition-all disabled:opacity-50" />
                <p className="mt-2 text-xs text-text-tertiary">Choose a descriptive name to identify this token later.</p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button type="submit" disabled={formSubmitting || !formName.trim()}
                  className="flex-1 rounded-xl bg-wa-green px-4 py-3 text-sm font-semibold text-text-inverse transition-all hover:bg-wa-green-dark hover:shadow-lg hover:shadow-wa-green/20 disabled:opacity-50">
                  {formSubmitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                      Creating...
                    </span>
                  ) : "Generate Token"}
                </button>
                <button type="button" onClick={() => { setShowModal(false); setFormName(""); }} disabled={formSubmitting}
                  className="rounded-xl border border-border-secondary px-5 py-3 text-sm font-medium text-text-secondary hover:bg-bg-hover transition-all disabled:opacity-50">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
