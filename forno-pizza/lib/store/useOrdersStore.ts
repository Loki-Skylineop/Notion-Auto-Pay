"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Order, OrderStatus } from "@/types";

interface OrdersState {
  orders: Order[];
  addOrder: (order: Order) => void;
  clear: () => void;
}

export const useOrdersStore = create<OrdersState>()(
  persist(
    (set) => ({
      orders: [],
      addOrder: (order) =>
        set((state) => ({ orders: [order, ...state.orders] })),
      clear: () => set({ orders: [] }),
    }),
    { name: "forno-orders" }
  )
);

/** Generate a human-facing order number, e.g. "FRN-4821". */
export function generateOrderId(): string {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `FRN-${n}`;
}

/**
 * Mock, time-based order status so the history feels alive:
 * fresh orders are "Preparing", then "On the way", then "Delivered".
 */
export function deriveStatus(order: Order): OrderStatus {
  if (order.status === "Cancelled") return "Cancelled";
  const elapsedMin = (Date.now() - order.createdAt) / 60000;
  if (elapsedMin < 12) return "Preparing";
  if (elapsedMin < order.estimatedMinutes) return "On the way";
  return "Delivered";
}
