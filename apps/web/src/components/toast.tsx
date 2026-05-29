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

export function toast(message: string, type: "success" | "error" = "success") {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("wago-toast", { detail: { message, type } }));
  }
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) return { toast };
  return ctx;
}

function ToastItem({ item, onDismiss }: { item: Toast; onDismiss: (id: string) => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(item.id), 300);
    }, 3500);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [item.id, onDismiss]);

  const isSuccess = item.type === "success";

  return (
    <div
      className={`pointer-events-auto flex items-start gap-3 min-w-72 max-w-sm rounded-2xl px-4 py-3 shadow-2xl transition-all duration-300
        ${visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}
        ${isSuccess
          ? "bg-[#1a2e28] border border-status-success-border"
          : "bg-[#2e1a1a] border border-status-error-border"
        }`}
    >
      <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full
        ${isSuccess ? "bg-status-success-text/20" : "bg-status-error-text/20"}`}>
        {isSuccess ? (
          <svg className="h-3 w-3 text-status-success-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="h-3 w-3 text-status-error-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}
      </div>
      <p className={`flex-1 text-sm font-medium leading-snug
        ${isSuccess ? "text-status-success-text" : "text-status-error-text"}`}>
        {item.message}
      </p>
      <button
        onClick={() => onDismiss(item.id)}
        className="mt-0.5 shrink-0 text-text-tertiary hover:text-text-secondary transition-colors"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children?: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((message: string, type: "success" | "error") => {
    const id = Math.random().toString(36).slice(2, 9);
    setToasts((prev) => [...prev.slice(-4), { id, message, type }]);
  }, []);

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
      <div className="pointer-events-none fixed bottom-6 right-6 z-[9999] flex flex-col-reverse gap-3">
        {toasts.map((t) => (
          <ToastItem key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
