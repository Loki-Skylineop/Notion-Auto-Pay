"use client";

import { create } from "zustand";
import type { Toast } from "@/types";

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

/** A single "fly to cart" animation in flight. */
export interface Flight {
  id: string;
  image: string;
  /** Origin viewport coordinates + size, captured from the source element. */
  x: number;
  y: number;
  size: number;
}

interface UIState {
  // Cart drawer
  cartOpen: boolean;
  openCart: () => void;
  closeCart: () => void;

  // Quick-view / product detail modal
  quickViewId: string | null;
  openQuickView: (id: string) => void;
  closeQuickView: () => void;

  // Toasts
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;

  // Fly-to-cart animation
  flights: Flight[];
  launchFlight: (image: string, rect: { x: number; y: number; size: number }) => void;
  endFlight: (id: string) => void;

  // Cart badge bounce trigger
  cartPulseKey: number;
  pulseCart: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  cartOpen: false,
  openCart: () => set({ cartOpen: true }),
  closeCart: () => set({ cartOpen: false }),

  quickViewId: null,
  openQuickView: (id) => set({ quickViewId: id }),
  closeQuickView: () => set({ quickViewId: null }),

  toasts: [],
  addToast: (toast) => {
    const id = uid();
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    setTimeout(() => get().dismissToast(id), 3400);
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  flights: [],
  launchFlight: (image, rect) =>
    set((state) => ({
      flights: [
        ...state.flights,
        { id: uid(), image, x: rect.x, y: rect.y, size: rect.size },
      ],
    })),
  endFlight: (id) =>
    set((state) => ({
      flights: state.flights.filter((f) => f.id !== id),
      cartPulseKey: state.cartPulseKey + 1,
    })),

  cartPulseKey: 0,
  pulseCart: () => set((state) => ({ cartPulseKey: state.cartPulseKey + 1 })),
}));
