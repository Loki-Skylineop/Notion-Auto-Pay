"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, RotateCcw } from "lucide-react";
import type { Order } from "@/types";
import { useOrdersStore, deriveStatus } from "@/lib/store/useOrdersStore";
import { useCartStore } from "@/lib/store/useCartStore";
import { useUIStore } from "@/lib/store/useUIStore";
import { useHasMounted } from "@/lib/hooks/useHasMounted";
import { getProduct } from "@/lib/data/products";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProductImage } from "@/components/ui/ProductImage";
import { formatPrice, formatDate, pluralize } from "@/lib/utils/format";
import { lineTotal } from "@/lib/utils/pricing";

function OrderCard({ order }: { order: Order }) {
  const [open, setOpen] = useState(false);
  const addLine = useCartStore((s) => s.addLine);
  const openCart = useUIStore((s) => s.openCart);
  const addToast = useUIStore((s) => s.addToast);
  const status = deriveStatus(order);
  const itemCount = order.items.reduce((n, l) => n + l.quantity, 0);

  const reorder = () => {
    let added = 0;
    order.items.forEach((line) => {
      const product = getProduct(line.productId);
      if (product) {
        addLine(product, line.sizeId, line.toppings, line.quantity);
        added += 1;
      }
    });
    if (added > 0) {
      addToast({ kind: "cart", title: "Added to cart", description: `Reordered ${order.id}` });
      openCart();
    }
  };

  return (
    <motion.li layout className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-3 text-left"
            aria-expanded={open}
          >
            <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-2xl bg-flame-500/10 text-xl">
              🍕
            </span>
            <span>
              <span className="flex items-center gap-2">
                <span className="font-display text-base font-semibold text-crust-50">{order.id}</span>
                <ChevronDown
                  className={`h-4 w-4 text-charcoal-400 transition-transform ${open ? "rotate-180" : ""}`}
                />
              </span>
              <span className="block text-xs text-charcoal-300">
                {formatDate(order.createdAt)} · {itemCount} {pluralize(itemCount, "item")}
              </span>
            </span>
          </button>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={status} />
          <span className="font-display text-lg font-bold text-gold-300">
            {formatPrice(order.total)}
          </span>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden border-t border-white/5"
          >
            <div className="space-y-3 p-4 sm:p-5">
              <ul className="space-y-3">
                {order.items.map((line) => (
                  <li key={line.lineId} className="flex items-center gap-3">
                    <div className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-xl ring-1 ring-inset ring-white/10">
                      <ProductImage src={line.image} alt={line.name} category={line.category} sizes="48px" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-crust-50">
                        {line.quantity} × {line.name}
                      </p>
                      {line.sizeId !== "regular" && (
                        <p className="text-xs text-charcoal-400">{line.sizeLabel}</p>
                      )}
                    </div>
                    <span className="text-sm tabular-nums text-charcoal-200">
                      {formatPrice(lineTotal(line))}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between border-t border-white/5 pt-3">
                <p className="text-sm text-charcoal-300">
                  Delivered to <span className="text-crust-100">{order.delivery.address}</span>
                </p>
                <button type="button" onClick={reorder} className="btn btn-ghost px-4 py-2 text-sm">
                  <RotateCcw className="h-4 w-4" />
                  Reorder
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

export function OrderHistory() {
  const mounted = useHasMounted();
  const orders = useOrdersStore((s) => s.orders);

  if (!mounted) {
    return <div className="h-40 animate-pulse rounded-3xl bg-white/5" aria-hidden />;
  }

  if (orders.length === 0) {
    return (
      <EmptyState
        emoji="🧾"
        title="No orders yet"
        description="When you place an order it'll appear here, so you can track and reorder in a tap."
        action={
          <Link href="/#menu" className="btn btn-primary px-5 py-2.5">
            Order something delicious
          </Link>
        }
      />
    );
  }

  return (
    <ul className="space-y-3">
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} />
      ))}
    </ul>
  );
}
