"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle2,
  Heart,
  Info,
  ShoppingBag,
  X,
  type LucideIcon,
} from "lucide-react";
import { useUIStore } from "@/lib/store/useUIStore";
import type { ToastKind } from "@/types";
import { cn } from "@/lib/utils/cn";

const KIND: Record<ToastKind, { icon: LucideIcon; accent: string }> = {
  success: { icon: CheckCircle2, accent: "text-basil-400" },
  cart: { icon: ShoppingBag, accent: "text-flame-400" },
  favorite: { icon: Heart, accent: "text-ember-400" },
  error: { icon: AlertCircle, accent: "text-ember-400" },
  info: { icon: Info, accent: "text-gold-300" },
};

export function Toaster() {
  const toasts = useUIStore((s) => s.toasts);
  const dismiss = useUIStore((s) => s.dismissToast);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex flex-col items-center gap-2 px-4 sm:bottom-auto sm:right-4 sm:top-20 sm:items-end"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const { icon: Icon, accent } = KIND[toast.kind];
          return (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 24, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-white/10 bg-charcoal-800/95 p-3.5 pr-2.5 shadow-drawer backdrop-blur"
            >
              <span
                className={cn(
                  "mt-0.5 grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-white/5",
                  accent
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-sm font-semibold text-crust-50">{toast.title}</p>
                {toast.description && (
                  <p className="mt-0.5 text-xs text-charcoal-300">{toast.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full text-charcoal-300 transition-colors hover:bg-white/10 hover:text-crust-50"
                aria-label="Dismiss notification"
              >
                <X className="h-4 w-4" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
