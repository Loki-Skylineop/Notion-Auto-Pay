"use client";

import { useRef } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ShoppingBag, X } from "lucide-react";
import { useUIStore } from "@/lib/store/useUIStore";
import { useCartStore } from "@/lib/store/useCartStore";
import { useCartTotals } from "@/lib/hooks/useCartTotals";
import { useHasMounted } from "@/lib/hooks/useHasMounted";
import { useLockBodyScroll } from "@/lib/hooks/useLockBodyScroll";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { CartItem } from "./CartItem";
import { OrderSummary } from "./OrderSummary";
import { EmptyState } from "@/components/ui/EmptyState";

export function CartDrawer() {
  const mounted = useHasMounted();
  const open = useUIStore((s) => s.cartOpen);
  const closeCart = useUIStore((s) => s.closeCart);
  const clear = useCartStore((s) => s.clear);
  const { lines, count } = useCartTotals();
  const panelRef = useRef<HTMLDivElement>(null);
  const isDesktop = useMediaQuery("(min-width: 640px)");

  useLockBodyScroll(open);
  useFocusTrap(panelRef, open, closeCart);

  if (!mounted) return null;

  const enterFrom = isDesktop ? { x: "100%" } : { y: "100%" };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[65] flex">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeCart}
            className="absolute inset-0 bg-charcoal-950/75 backdrop-blur-sm"
            aria-hidden
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Shopping cart"
            tabIndex={-1}
            initial={enterFrom}
            animate={{ x: 0, y: 0 }}
            exit={enterFrom}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
            className="relative z-10 ml-auto mt-auto flex max-h-[86vh] w-full flex-col rounded-t-4xl bg-charcoal-900 shadow-drawer ring-1 ring-inset ring-white/10 sm:mt-0 sm:h-full sm:max-h-full sm:max-w-md sm:rounded-none sm:rounded-l-4xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/5 p-5">
              <h2 className="flex items-center gap-2 font-display text-xl font-bold text-crust-50">
                <ShoppingBag className="h-5 w-5 text-flame-400" />
                Your cart
                {count > 0 && (
                  <span className="rounded-full bg-flame-500/15 px-2 py-0.5 text-sm font-semibold text-flame-300">
                    {count}
                  </span>
                )}
              </h2>
              <button
                type="button"
                onClick={closeCart}
                aria-label="Close cart"
                className="grid h-10 w-10 place-items-center rounded-full bg-white/5 text-crust-100 transition-colors hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Body */}
            {lines.length === 0 ? (
              <div className="flex flex-1 items-center justify-center p-6">
                <EmptyState
                  emoji="🛒"
                  title="Your cart is empty"
                  description="Looks like you haven't added anything yet. Let's fix that."
                  action={
                    <Link href="/#menu" onClick={closeCart} className="btn btn-primary px-5 py-2.5">
                      Browse the menu
                    </Link>
                  }
                />
              </div>
            ) : (
              <>
                <ul className="min-h-0 flex-1 divide-y divide-white/5 overflow-y-auto px-5">
                  <AnimatePresence initial={false}>
                    {lines.map((line) => (
                      <CartItem key={line.lineId} line={line} />
                    ))}
                  </AnimatePresence>
                </ul>

                <div className="space-y-4 border-t border-white/10 bg-charcoal-900/95 p-5">
                  <OrderSummary />
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={clear}
                      className="btn btn-ghost px-4 py-3 text-sm"
                    >
                      Clear
                    </button>
                    <Link
                      href="/checkout"
                      onClick={closeCart}
                      className="btn btn-primary h-12 flex-1 text-base"
                    >
                      Checkout
                    </Link>
                  </div>
                </div>
              </>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
