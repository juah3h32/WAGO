const STATUS_CONFIG: Record<string, { label: string; dot: string; pill: string }> = {
  connected: {
    label: "Conectado",
    dot: "bg-status-success-text animate-pulse-dot",
    pill: "bg-status-success-bg text-status-success-text border border-status-success-border",
  },
  scan_qr: {
    label: "Escanear QR",
    dot: "bg-status-warning-text animate-pulse-dot",
    pill: "bg-status-warning-bg text-status-warning-text border border-status-warning-border",
  },
  pending: {
    label: "Pendiente",
    dot: "bg-status-neutral-text",
    pill: "bg-status-neutral-bg text-status-neutral-text border border-border-secondary",
  },
  failed: {
    label: "Fallido",
    dot: "bg-status-error-text",
    pill: "bg-status-error-bg text-status-error-text border border-status-error-border",
  },
  stopped: {
    label: "Detenido",
    dot: "bg-status-neutral-text opacity-50",
    pill: "bg-status-neutral-bg text-status-neutral-text border border-border-secondary opacity-60",
  },
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? {
    label: status,
    dot: "bg-status-neutral-text",
    pill: "bg-status-neutral-bg text-status-neutral-text border border-border-secondary",
  };

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${cfg.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}
