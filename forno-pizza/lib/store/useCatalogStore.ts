"use client";

import { create } from "zustand";
import type { SortKey, Tag } from "@/types";
import type { CategoryFilter } from "@/components/catalog/CategoryTabs";

interface CatalogState {
  category: CategoryFilter;
  query: string;
  sort: SortKey;
  filterTag: Tag | null;
  setCategory: (category: CategoryFilter) => void;
  setQuery: (query: string) => void;
  setSort: (sort: SortKey) => void;
  setFilterTag: (tag: Tag | null) => void;
  reset: () => void;
}

/** Ephemeral catalog UI state, shared so the header nav can drive the menu. */
export const useCatalogStore = create<CatalogState>((set) => ({
  category: "all",
  query: "",
  sort: "popular",
  filterTag: null,
  setCategory: (category) => set({ category }),
  setQuery: (query) => set({ query }),
  setSort: (sort) => set({ sort }),
  setFilterTag: (filterTag) => set({ filterTag }),
  reset: () => set({ category: "all", query: "", filterTag: null }),
}));
