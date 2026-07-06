"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CartLine, Product, Topping } from "@/types";
import { makeLineId, unitPriceFor } from "@/lib/utils/pricing";

interface CartState {
  lines: CartLine[];
  /** Add a configured product to the cart (merges identical configurations). */
  addLine: (
    product: Product,
    sizeId: string,
    toppings: Topping[],
    quantity: number
  ) => void;
  removeLine: (lineId: string) => void;
  setQuantity: (lineId: string, quantity: number) => void;
  increment: (lineId: string) => void;
  decrement: (lineId: string) => void;
  clear: () => void;
}

export const useCartStore = create<CartState>()(
  persist(
    (set) => ({
      lines: [],

      addLine: (product, sizeId, toppings, quantity) =>
        set((state) => {
          const size =
            product.sizes.find((s) => s.id === sizeId) ?? product.sizes[0];
          const lineId = makeLineId(product.id, size.id, toppings);
          const unitPrice = unitPriceFor(size.price, toppings);

          const existing = state.lines.find((l) => l.lineId === lineId);
          if (existing) {
            return {
              lines: state.lines.map((l) =>
                l.lineId === lineId
                  ? { ...l, quantity: l.quantity + quantity }
                  : l
              ),
            };
          }

          const line: CartLine = {
            lineId,
            productId: product.id,
            name: product.name,
            image: product.image,
            category: product.category,
            sizeId: size.id,
            sizeLabel: size.label,
            basePrice: size.price,
            unitPrice,
            toppings,
            quantity,
          };
          return { lines: [...state.lines, line] };
        }),

      removeLine: (lineId) =>
        set((state) => ({
          lines: state.lines.filter((l) => l.lineId !== lineId),
        })),

      setQuantity: (lineId, quantity) =>
        set((state) => ({
          lines:
            quantity <= 0
              ? state.lines.filter((l) => l.lineId !== lineId)
              : state.lines.map((l) =>
                  l.lineId === lineId ? { ...l, quantity } : l
                ),
        })),

      increment: (lineId) =>
        set((state) => ({
          lines: state.lines.map((l) =>
            l.lineId === lineId ? { ...l, quantity: l.quantity + 1 } : l
          ),
        })),

      decrement: (lineId) =>
        set((state) => ({
          lines: state.lines
            .map((l) =>
              l.lineId === lineId ? { ...l, quantity: l.quantity - 1 } : l
            )
            .filter((l) => l.quantity > 0),
        })),

      clear: () => set({ lines: [] }),
    }),
    { name: "forno-cart" }
  )
);
