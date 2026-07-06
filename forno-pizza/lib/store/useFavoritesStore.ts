"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface FavoritesState {
  ids: string[];
  toggle: (id: string) => boolean; // returns the new favorited state
  isFavorite: (id: string) => boolean;
  clear: () => void;
}

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      ids: [],

      toggle: (id) => {
        const has = get().ids.includes(id);
        set((state) => ({
          ids: has
            ? state.ids.filter((x) => x !== id)
            : [...state.ids, id],
        }));
        return !has;
      },

      isFavorite: (id) => get().ids.includes(id),

      clear: () => set({ ids: [] }),
    }),
    { name: "forno-favorites" }
  )
);
