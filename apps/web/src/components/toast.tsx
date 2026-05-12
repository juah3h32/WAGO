"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error";
}

interface ToastContextValue {
  toast: (message: string, type: "success" | "error") => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// Global function to trigger toasts from anywhere (even outside React islands)
export function toast(message: string, type: "success" | "error" = "success") {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("wago-toast", { detail: { message, type } }));
  }
}

export function useToast() {
  const ctx = useContext(ToastContext);
  // If we are in a component that isn't wrapped by ToastProvider (common in Astro),
  // we just return the global toast function. This prevents the warning.
  if (!ctx) {
    return { toast };
  }
  return ctx;
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // trigger slide-in
    const frame = requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(toast.id), 200);
    }, 3000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [toast.id, onDismiss]);

  return (
    <div
      className={`pointer-events-auto flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium shadow-lg transition-all duration-200 ${
        visible
          ? "translate-y-0 opacity-100"
          : "translate-y-2 opacity-0"
      } ${
        toast.type === "success"
          ? "border-status-success-border bg-bg-secondary text-status-success-text"
          : "border-status-error-border bg-bg-secondary text-status-error-text"
      }`}
    >
      <span>{toast.type === "success" ? "\u2713" : "\u2717"}</span>
      <span>{toast.message}</span>
    </div>
  );
}

export function ToastProvider({ children }: { children?: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, type: "success" | "error") => {
      const id = Math.random().toString(36).slice(2, 9);
      setToasts((prev) => [...prev, { id, message, type }]);
    },
    []
  );

  useEffect(() => {
    const handler = (e: Event) => {
      const { message, type } = (e as CustomEvent).detail;
      addToast(message, type);
    };
    window.addEventListener("wago-toast", handler);
    return () => window.removeEventListener("wago-toast", handler);
  }, [addToast]);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
