"use client";

import { Truck } from "lucide-react";
import { useCartTotals } from "@/lib/hooks/useCartTotals";
import { FREE_DELIVERY_THRESHOLD } from "@/lib/utils/constants";
import { formatPrice } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

/** Subtotal / delivery / total breakdown with a free-delivery progress nudge. */
export function OrderSummary({ showProgress = true }: { showProgress?: boolean }) {
  const { subtotal, deliveryFee, total } = useCartTotals();

  const remaining = Math.max(0, FREE_DELIVERY_THRESHOLD - subtotal);
  const progress = Math.min(100, (subtotal / FREE_DELIVERY_THRESHOLD) * 100);
  const freeUnlocked = subtotal >= FREE_DELIVERY_THRESHOLD && subtotal > 0;

  return (
    <div className="space-y-3">
      {showProgress && subtotal > 0 && (
        <div className="rounded-2xl bg-white/[0.03] p-3 ring-1 ring-inset ring-white/5">
          <div className="mb-2 flex items-center gap-2 text-xs text-charcoal-200">
            <Truck className="h-4 w-4 text-flame-400" />
            {freeUnlocked ? (
              <span className="font-medium text-basil-400">
                You&apos;ve unlocked free delivery!
              </span>
            ) : (
              <span>
                Add <span className="font-semibold text-flame-300">{formatPrice(remaining)}</span>{" "}
                more for free delivery
              </span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                freeUnlocked ? "bg-basil-500" : "bg-flame-gradient"
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <dl className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-charcoal-300">Subtotal</dt>
          <dd className="font-medium tabular-nums text-crust-50">{formatPrice(subtotal)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-charcoal-300">Delivery</dt>
          <dd className="font-medium tabular-nums text-crust-50">
            {deliveryFee === 0 ? (
              <span className="text-basil-400">Free</span>
            ) : (
              formatPrice(deliveryFee)
            )}
          </dd>
        </div>
        <div className="flex items-center justify-between border-t border-white/10 pt-3 text-base">
          <dt className="font-semibold text-crust-50">Total</dt>
          <dd className="font-display text-xl font-bold tabular-nums text-gold-300">
            {formatPrice(total)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
