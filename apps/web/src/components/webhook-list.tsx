"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { EventLog } from "@/components/event-log";
import { CopyButton } from "@/components/copy-button";
import { WebhookListSkeleton } from "@/components/skeletons";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";

interface WebhookConfig {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  signingSecret: string;
  active: boolean;
  createdAt: string;
}

const EVENT_TYPES = [
  "message",
  "message.any",
  "message.ack",
  "message.reaction",
  "message.revoked",
  "state.change",
  "group.join",
  "group.leave",
  "session.status",
];

export function WebhookList({ connectionId, apiUrl, activeTokenValue }: {
  connectionId: string;
  apiUrl?: string;
  activeTokenValue?: string | null;
}) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [formUrl, setFormUrl] = useState("");
  const [formEvents, setFormEvents] = useState<string[]>([]);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [newWebhookSecret, setNewWebhookSecret] = useState<{ id: string; secret: string } | null>(null);
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(
    new Set()
  );
  const [expandedWebhook, setExpandedWebhook] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  const fetchWebhooks = useCallback(async () => {
    try {
      const data = await apiFetch(
        `/api/connections/${connectionId}/webhooks`
      );
      setWebhooks(data ?? []);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load webhooks"
      );
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  function toggleEventType(event: string) {
    setFormEvents((prev) =>
      prev.includes(event)
        ? prev.filter((e) => e !== event)
        : [...prev, event]
    );
  }

  async function handleCreate() {
    if (!formUrl.trim()) {
      setFormError("URL is required.");
      return;
    }
    if (formEvents.length === 0) {
      setFormError("Select at least one event type.");
      return;
    }

    setFormSubmitting(true);
    setFormError(null);

    try {
      const created = await apiFetch(`/api/connections/${connectionId}/webhooks`, {
        method: "POST",
        body: JSON.stringify({ url: formUrl.trim(), events: formEvents }),
      });
      setFormUrl("");
      setFormEvents([]);
      setShowForm(false);
      // Guardar el secret completo — solo está disponible en la respuesta de creación
      if (created?.signingSecret && !created.signingSecret.endsWith("…")) {
        setNewWebhookSecret({ id: created.id, secret: created.signingSecret });
      }
      toast("Webhook creado", "success");
      await fetchWebhooks();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create webhook"
      );
    } finally {
      setFormSubmitting(false);
    }
  }

  async function handleToggleActive(webhook: WebhookConfig) {
    // Optimistic update
    const previousWebhooks = webhooks;
    setWebhooks((prev) =>
      prev.map((w) =>
        w.id === webhook.id ? { ...w, active: !w.active } : w
      )
    );
    setTogglingIds((prev) => new Set(prev).add(webhook.id));

    try {
      await apiFetch(`/api/webhooks/${webhook.id}`, {
        method: "PUT",
        body: JSON.stringify({ active: !webhook.active }),
      });
      toast(
        webhook.active ? "Webhook deactivated" : "Webhook activated",
        "success"
      );
    } catch (err) {
      // Rollback
      setWebhooks(previousWebhooks);
      toast(
        err instanceof Error ? err.message : "Failed to update webhook",
        "error"
      );
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(webhook.id);
        return next;
      });
    }
  }

  async function handleDelete(webhookId: string) {
    const confirmed = await confirm({
      title: "Delete webhook",
      message:
        "Are you sure you want to delete this webhook? This action cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;

    // Optimistic remove
    const previousWebhooks = webhooks;
    setWebhooks((prev) => prev.filter((w) => w.id !== webhookId));
    if (expandedWebhook === webhookId) {
      setExpandedWebhook(null);
    }
    setDeletingIds((prev) => new Set(prev).add(webhookId));

    try {
      await apiFetch(`/api/webhooks/${webhookId}`, { method: "DELETE" });
      toast("Webhook deleted", "success");
    } catch (err) {
      // Rollback
      setWebhooks(previousWebhooks);
      toast(
        err instanceof Error ? err.message : "Failed to delete webhook",
        "error"
      );
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(webhookId);
        return next;
      });
    }
  }

  async function handleTest(webhookId: string) {
    setTestingIds((prev) => new Set(prev).add(webhookId));
    try {
      await apiFetch(`/api/webhooks/${webhookId}/test`, { method: "POST" });
      toast("Test event sent", "success");
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Failed to send test event",
        "error"
      );
    } finally {
      setTestingIds((prev) => {
        const next = new Set(prev);
        next.delete(webhookId);
        return next;
      });
    }
  }

  function toggleSecretReveal(webhookId: string) {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(webhookId)) {
        next.delete(webhookId);
      } else {
        next.add(webhookId);
      }
      return next;
    });
  }

  function toggleExpand(webhookId: string) {
    setExpandedWebhook((prev) => (prev === webhookId ? null : webhookId));
  }

  return (
    <div className="mt-8 border-t border-border-primary pt-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-text-primary">
            Webhooks
          </h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            Receive WhatsApp events at your endpoints.
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark"
          >
            Add Webhook
          </button>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-status-error-border bg-status-error-bg p-3 text-sm text-status-error-text">
          {error}
        </div>
      )}

      {/* Signing secret + clave de integración — solo visible una vez al crear */}
      {newWebhookSecret && (() => {
        const integrationKey = activeTokenValue
          ? "wago_v1_" + encodeURIComponent(JSON.stringify({
              url: apiUrl || "https://api.recursomusical.com.mx",
              token: activeTokenValue,
              connectionId,
              webhookSecret: newWebhookSecret.secret,
            }))
          : null;
        return (
          <div className="mt-4 space-y-3">
            {/* Clave de integración GO2026 — lo más importante */}
            {integrationKey && (
              <div className="rounded-xl border border-wa-green/30 bg-wa-green/5 px-4 py-3">
                <p className="text-xs font-semibold text-wa-green mb-1">Clave de integración GO2026 — copiala ahora</p>
                <p className="text-[10px] text-wa-green/70 mb-2">
                  Admin GO2026 → WhatsApp → <strong>Conectar WAGO</strong> → pegar esta clave
                </p>
                <div className="flex items-start gap-2">
                  <code className="flex-1 break-all text-[10px] font-mono text-text-primary bg-bg-elevated rounded-lg px-3 py-2 border border-border-secondary leading-relaxed">
                    {integrationKey}
                  </code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(integrationKey); toast("Clave copiada", "success"); }}
                    className="shrink-0 mt-0.5 rounded-lg border border-border-secondary bg-bg-secondary p-2 hover:bg-bg-hover transition-all">
                    <svg className="h-4 w-4 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                    </svg>
                  </button>
                </div>
              </div>
            )}
            {/* Signing secret por separado */}
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
              <p className="text-xs font-semibold text-amber-400 mb-1">Signing Secret — solo para .env manual</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all text-xs font-mono text-text-primary bg-bg-elevated rounded-lg px-3 py-2 border border-border-secondary">
                  {newWebhookSecret.secret}
                </code>
                <button
                  onClick={() => { navigator.clipboard.writeText(newWebhookSecret.secret); toast("Copiado", "success"); }}
                  className="shrink-0 rounded-lg border border-border-secondary bg-bg-secondary p-2 hover:bg-bg-hover transition-all">
                  <svg className="h-4 w-4 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/>
                  </svg>
                </button>
              </div>
              <button onClick={() => setNewWebhookSecret(null)} className="mt-2 text-xs text-amber-400/70 hover:text-amber-400 transition-colors">
                Ya lo guardé ✓
              </button>
            </div>
          </div>
        );
      })()}

      {/* Add Webhook Form */}
      {showForm && (
        <div className="mt-4 rounded-xl border border-border-secondary bg-bg-secondary p-5">
          <h3 className="text-sm font-semibold text-text-primary">
            New Webhook
          </h3>

          <div className="mt-4">
            <label
              htmlFor="webhook-url"
              className="mb-1.5 block text-sm font-medium text-text-secondary"
            >
              Endpoint URL
            </label>
            <input
              id="webhook-url"
              type="url"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              placeholder="https://example.com/webhook"
              className="block w-full rounded-lg border border-border-secondary bg-bg-elevated px-3.5 py-2.5 text-sm text-text-primary transition-colors duration-150 placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green"
            />
          </div>

          <div className="mt-4">
            <span className="mb-2 block text-sm font-medium text-text-secondary">
              Events
            </span>
            <div className="flex flex-wrap gap-2">
              {EVENT_TYPES.map((event) => (
                <label
                  key={event}
                  className={`inline-flex cursor-pointer items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 ${
                    formEvents.includes(event)
                      ? "border-wa-green bg-wa-green text-text-inverse"
                      : "border-border-secondary bg-bg-elevated text-text-secondary hover:bg-bg-hover"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={formEvents.includes(event)}
                    onChange={() => toggleEventType(event)}
                    className="sr-only"
                  />
                  {event}
                </label>
              ))}
            </div>
          </div>

          {formError && (
            <p className="mt-3 text-sm text-status-error-text">{formError}</p>
          )}

          <div className="mt-5 flex gap-2">
            <button
              onClick={handleCreate}
              disabled={formSubmitting}
              className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-text-inverse transition-colors duration-150 hover:bg-wa-green-dark disabled:opacity-50"
            >
              {formSubmitting ? "Saving..." : "Save Webhook"}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setFormUrl("");
                setFormEvents([]);
                setFormError(null);
              }}
              className="rounded-lg border border-border-secondary px-4 py-2 text-sm font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && <WebhookListSkeleton />}

      {/* Empty state */}
      {!loading && !error && webhooks.length === 0 && !showForm && (
        <div className="mt-6 flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border-primary bg-bg-secondary">
            <span className="text-2xl">🔗</span>
          </div>
          <p className="mt-3 text-sm text-text-secondary">
            No webhooks configured. Add one to start receiving events.
          </p>
        </div>
      )}

      {/* Webhook cards */}
      {webhooks.length > 0 && (
        <div className="mt-4 space-y-3">
          {webhooks.map((webhook) => (
            <div
              key={webhook.id}
              className="rounded-xl border border-border-primary bg-bg-secondary p-4 transition-colors duration-150 hover:border-border-secondary"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => toggleExpand(webhook.id)}
                    className="break-all text-left text-sm font-medium text-wa-green transition-colors duration-150 hover:underline"
                  >
                    {webhook.url}
                  </button>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {webhook.events.map((event) => (
                      <span
                        key={event}
                        className="inline-flex items-center rounded-full bg-bg-elevated px-2 py-0.5 text-xs font-medium text-text-secondary"
                      >
                        {event}
                      </span>
                    ))}
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-text-tertiary">Secret:</span>
                    <code className="text-xs text-text-secondary">
                      {revealedSecrets.has(webhook.id)
                        ? webhook.signingSecret
                        : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
                    </code>
                    <button
                      onClick={() => toggleSecretReveal(webhook.id)}
                      className="text-xs text-text-tertiary underline transition-colors duration-150 hover:text-wa-green"
                    >
                      {revealedSecrets.has(webhook.id) ? "Hide" : "Reveal"}
                    </button>
                    {revealedSecrets.has(webhook.id) && (
                      <CopyButton text={webhook.signingSecret} />
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => handleTest(webhook.id)}
                    disabled={testingIds.has(webhook.id)}
                    className="rounded-lg border border-border-secondary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
                  >
                    {testingIds.has(webhook.id) ? "..." : "Test"}
                  </button>

                  <button
                    onClick={() => handleToggleActive(webhook)}
                    disabled={togglingIds.has(webhook.id)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-wa-green focus:ring-offset-2 focus:ring-offset-bg-primary disabled:opacity-50 ${
                      webhook.active ? "bg-wa-green" : "bg-bg-hover"
                    }`}
                    title={webhook.active ? "Active" : "Inactive"}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-150 ${
                        webhook.active ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>

                  <button
                    onClick={() => handleDelete(webhook.id)}
                    disabled={deletingIds.has(webhook.id)}
                    className="rounded-lg border border-status-error-border px-3 py-1.5 text-xs font-medium text-status-error-text transition-colors duration-150 hover:bg-status-error-bg disabled:opacity-50"
                  >
                    {deletingIds.has(webhook.id) ? "..." : "Delete"}
                  </button>
                </div>
              </div>

              <EventLog
                webhookId={webhook.id}
                expanded={expandedWebhook === webhook.id}
                onToggle={() => toggleExpand(webhook.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
