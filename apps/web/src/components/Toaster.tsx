"use client";

/**
 * A small toast system, built here rather than pulled from a library, so it
 * matches the app's motion and theme exactly and carries no weight we did not
 * choose. Toasts speak in the app's voice: a swap that landed, a signature the
 * wallet turned down, a limit order now resting. They stack, they auto dismiss,
 * and an error one waits a little longer because a person needs time to read bad
 * news. An optional link points at Etherscan when there is a hash to show.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckCircle2, XCircle, Info, Loader2, ExternalLink, X } from "lucide-react";

type ToastKind = "success" | "error" | "info" | "pending";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  href?: string;
  hrefLabel?: string;
  duration: number;
}

interface ToastInput {
  kind?: ToastKind;
  title: string;
  detail?: string;
  href?: string;
  hrefLabel?: string;
  duration?: number;
}

interface ToastApi {
  push: (t: ToastInput) => number;
  dismiss: (id: number) => void;
  success: (title: string, detail?: string, extra?: Partial<ToastInput>) => number;
  error: (title: string, detail?: string, extra?: Partial<ToastInput>) => number;
  info: (title: string, detail?: string, extra?: Partial<ToastInput>) => number;
}

const ToastContext = createContext<ToastApi | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = ++counter;
      const kind = input.kind ?? "info";
      const duration = input.duration ?? (kind === "error" ? 8000 : kind === "pending" ? 0 : 5000);
      const toast: Toast = {
        id,
        kind,
        title: input.title,
        detail: input.detail,
        href: input.href,
        hrefLabel: input.hrefLabel,
        duration,
      };
      setToasts((list) => [...list, toast]);
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      dismiss,
      success: (title, detail, extra) => push({ kind: "success", title, detail, ...extra }),
      error: (title, detail, extra) => push({ kind: "error", title, detail, ...extra }),
      info: (title, detail, extra) => push({ kind: "info", title, detail, ...extra }),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const ICONS: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 size={18} />,
  error: <XCircle size={18} />,
  info: <Info size={18} />,
  pending: <Loader2 size={18} className="toast-spin" />,
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-viewport" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [leaving, setLeaving] = useState(false);

  const close = useCallback(() => {
    setLeaving(true);
    setTimeout(() => onDismiss(toast.id), 180);
  }, [toast.id, onDismiss]);

  return (
    <div
      className={`toast toast-${toast.kind} ${leaving ? "toast-leaving" : ""}`}
      role={toast.kind === "error" ? "alert" : "status"}
    >
      <span className={`toast-icon toast-icon-${toast.kind}`}>{ICONS[toast.kind]}</span>
      <div className="toast-body">
        <p className="toast-title">{toast.title}</p>
        {toast.detail ? <p className="toast-detail">{toast.detail}</p> : null}
        {toast.href ? (
          <a className="toast-link" href={toast.href} target="_blank" rel="noreferrer">
            {toast.hrefLabel ?? "View on Etherscan"}
            <ExternalLink size={13} />
          </a>
        ) : null}
      </div>
      {toast.kind !== "pending" ? (
        <button className="toast-close" onClick={close} aria-label="Dismiss">
          <X size={15} />
        </button>
      ) : null}
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

/** Mounted once by the layout so the provider wraps the tree. */
export function Toaster() {
  // The provider already renders the viewport; this is a no-op anchor kept for
  // symmetry with how the layout imports a single component.
  useEffect(() => undefined, []);
  return null;
}
