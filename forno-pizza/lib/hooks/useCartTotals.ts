"use client";

import { useCartStore } from "@/lib/store/useCartStore";
import { cartCount, cartSubtotal } from "@/lib/utils/pricing";
import { deliveryFeeFor } from "@/lib/utils/constants";

/** Convenience hook exposing derived cart totals. */
export function useCartTotals() {
  const lines = useCartStore((s) => s.lines);
  const subtotal = cartSubtotal(lines);
  const deliveryFee = deliveryFeeFor(subtotal);
  const count = cartCount(lines);
  return {
    lines,
    count,
    subtotal,
    deliveryFee,
    total: subtotal + deliveryFee,
  };
}
