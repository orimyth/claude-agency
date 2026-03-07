"use client";

import { createContext, useContext, useCallback, useState, useEffect, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastType = "success" | "info" | "warning" | "error";

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

interface ToastContextValue {
  addToast: (toast: Omit<Toast, "id">) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue>({ addToast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

const TYPE_STYLES: Record<ToastType, { icon: string; border: string; iconColor: string; bg: string }> = {
  success: {
    icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
    border: "border-emerald-200",
    iconColor: "text-emerald-500",
    bg: "bg-emerald-50",
  },
  info: {
    icon: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    border: "border-blue-200",
    iconColor: "text-blue-500",
    bg: "bg-blue-50",
  },
  warning: {
    icon: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
    border: "border-amber-200",
    iconColor: "text-amber-500",
    bg: "bg-amber-50",
  },
  error: {
    icon: "M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z",
    border: "border-red-200",
    iconColor: "text-red-500",
    bg: "bg-red-50",
  },
};

// ---------------------------------------------------------------------------
// Toast Item Component
// ---------------------------------------------------------------------------

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [isExiting, setIsExiting] = useState(false);
  const style = TYPE_STYLES[toast.type];

  useEffect(() => {
    const duration = toast.duration ?? 5000;
    const exitTimer = setTimeout(() => setIsExiting(true), duration - 300);
    const removeTimer = setTimeout(onDismiss, duration);
    return () => {
      clearTimeout(exitTimer);
      clearTimeout(removeTimer);
    };
  }, [toast.duration, onDismiss]);

  const handleDismiss = () => {
    setIsExiting(true);
    setTimeout(onDismiss, 300);
  };

  return (
    <div
      className={`
        flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg border backdrop-blur-sm
        bg-white/95 ${style.border}
        transition-all duration-300 ease-out max-w-sm w-full
        ${isExiting
          ? "opacity-0 translate-x-8 scale-95"
          : "opacity-100 translate-x-0 scale-100"
        }
      `}
      style={{ animation: "toastSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1)" }}
    >
      <div className={`w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center ${style.bg}`}>
        <svg className={`w-4.5 h-4.5 ${style.iconColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={style.icon} />
        </svg>
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <p className="text-sm font-semibold text-gray-900 leading-tight">{toast.title}</p>
        {toast.message && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{toast.message}</p>
        )}
      </div>
      <button
        onClick={handleDismiss}
        className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition-colors mt-0.5"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let toastCounter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = `toast-${++toastCounter}`;
    setToasts((prev) => [...prev.slice(-4), { ...toast, id }]); // Keep max 5
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Toast container — fixed bottom-right */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col-reverse gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <ToastItem toast={toast} onDismiss={() => removeToast(toast.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
