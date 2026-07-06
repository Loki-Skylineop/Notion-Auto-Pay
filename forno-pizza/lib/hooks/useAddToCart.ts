"use client";

import { useCallback } from "react";
import { useCartStore } from "@/lib/store/useCartStore";
import { useUIStore } from "@/lib/store/useUIStore";
import type { Product, Topping } from "@/types";

interface AddOptions {
  sizeId?: string;
  toppings?: Topping[];
  quantity?: number;
  /** Source element to launch the fly-to-cart animation from. */
  sourceEl?: HTMLElement | null;
}

/** Adds a product to the cart with the fly-to-cart animation + toast. */
export function useAddToCart() {
  const addLine = useCartStore((s) => s.addLine);
  const launchFlight = useUIStore((s) => s.launchFlight);
  const pulseCart = useUIStore((s) => s.pulseCart);
  const addToast = useUIStore((s) => s.addToast);

  return useCallback(
    (product: Product, options: AddOptions = {}) => {
      const {
        sizeId = product.sizes[0].id,
        toppings = [],
        quantity = 1,
        sourceEl,
      } = options;

      addLine(product, sizeId, toppings, quantity);

      const size = product.sizes.find((s) => s.id === sizeId) ?? product.sizes[0];

      if (sourceEl && typeof window !== "undefined") {
        const rect = sourceEl.getBoundingClientRect();
        const flightSize = Math.min(rect.width, rect.height, 130);
        launchFlight(product.image, {
          x: rect.left + rect.width / 2 - flightSize / 2,
          y: rect.top + rect.height / 2 - flightSize / 2,
          size: flightSize,
        });
      } else {
        pulseCart();
      }

      const sizeNote =
        product.sizes.length > 1 ? ` · ${size.label}` : "";
      addToast({
        kind: "cart",
        title: `${product.name} added`,
        description: `${quantity} in cart${sizeNote}`,
      });
    },
    [addLine, launchFlight, pulseCart, addToast]
  );
}
