"use client";

import { useCartStore } from "./useCartStore";
import { useFavoritesStore } from "./useFavoritesStore";
import { useOrdersStore } from "./useOrdersStore";
import { useProfileStore } from "./useProfileStore";

const PERSIST_KEYS = [
  "forno-cart",
  "forno-favorites",
  "forno-orders",
  "forno-profile",
];

/** Wipe every piece of locally-stored state (cart, favorites, orders, profile). */
export function resetAllData() {
  useCartStore.getState().clear();
  useFavoritesStore.getState().clear();
  useOrdersStore.getState().clear();
  useProfileStore.getState().clear();

  if (typeof window !== "undefined") {
    PERSIST_KEYS.forEach((key) => window.localStorage.removeItem(key));
  }
}
