"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { Product, SortKey } from "@/types";
import { products } from "@/lib/data/products";
import { CATEGORIES } from "@/lib/utils/constants";
import { CategoryTabs } from "./CategoryTabs";
import { SearchBar } from "./SearchBar";
import { FilterBar } from "./FilterBar";
import { ProductGrid } from "./ProductGrid";
import { ProductCardSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useCatalogStore } from "@/lib/store/useCatalogStore";

function matchesQuery(product: Product, q: string): boolean {
  if (!q) return true;
  const haystack = [
    product.name,
    product.description,
    ...product.tags,
    ...product.ingredients,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q.toLowerCase());
}

function sortProducts(list: Product[], sort: SortKey): Product[] {
  const sorted = [...list];
  switch (sort) {
    case "price-asc":
      return sorted.sort(
        (a, b) => Math.min(...a.sizes.map((s) => s.price)) - Math.min(...b.sizes.map((s) => s.price))
      );
    case "price-desc":
      return sorted.sort(
        (a, b) => Math.min(...b.sizes.map((s) => s.price)) - Math.min(...a.sizes.map((s) => s.price))
      );
    case "name":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "popular":
    default:
      return sorted.sort((a, b) => b.popularity - a.popularity);
  }
}

export function Catalog() {
  const category = useCatalogStore((s) => s.category);
  const setCategory = useCatalogStore((s) => s.setCategory);
  const query = useCatalogStore((s) => s.query);
  const setQuery = useCatalogStore((s) => s.setQuery);
  const sort = useCatalogStore((s) => s.sort);
  const setSort = useCatalogStore((s) => s.setSort);
  const filterTag = useCatalogStore((s) => s.filterTag);
  const setFilterTag = useCatalogStore((s) => s.setFilterTag);
  const resetCatalog = useCatalogStore((s) => s.reset);
  const [loading, setLoading] = useState(true);

  // Brief skeleton state on mount to showcase loading polish.
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 500);
    return () => clearTimeout(t);
  }, []);

  const filtered = useMemo(() => {
    let list = products.filter((p) => matchesQuery(p, query));
    if (category !== "all") list = list.filter((p) => p.category === category);
    if (filterTag) list = list.filter((p) => p.tags.includes(filterTag));
    return sortProducts(list, sort);
  }, [category, query, sort, filterTag]);

  const showSections = category === "all";
  const resetFilters = () => resetCatalog();

  return (
    <section id="menu" className="container-page scroll-mt-24 py-14 sm:py-20">
      <div className="mb-8 flex flex-col gap-2 text-center sm:text-left">
        <span className="text-sm font-semibold uppercase tracking-[0.2em] text-flame-400">
          Our menu
        </span>
        <h2 className="font-display text-3xl font-bold text-crust-50 sm:text-4xl">
          Made to order, fired to perfection
        </h2>
      </div>

      {/* Controls */}
      <div className="sticky top-[var(--header-height)] z-30 -mx-4 mb-8 space-y-4 bg-charcoal-950/80 px-4 py-4 backdrop-blur-lg sm:mx-0 sm:rounded-3xl sm:px-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <CategoryTabs value={category} onChange={setCategory} />
          <SearchBar id="menu-search" value={query} onChange={setQuery} className="lg:w-72" />
        </div>
        <FilterBar
          sort={sort}
          onSortChange={setSort}
          filterTag={filterTag}
          onFilterChange={setFilterTag}
        />
      </div>

      {/* Results */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <ProductCardSkeleton key={i} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          emoji="🔍"
          title="No dishes match your search"
          description="Try a different keyword or clear your filters to see the full menu."
          action={
            <button onClick={resetFilters} className="btn btn-primary px-5 py-2.5">
              Clear filters
            </button>
          }
        />
      ) : showSections ? (
        <div className="space-y-14">
          {CATEGORIES.map((cat) => {
            const items = filtered.filter((p) => p.category === cat.id);
            if (items.length === 0) return null;
            return (
              <motion.div key={cat.id} layout>
                <div className="mb-5 flex items-end justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl" aria-hidden>
                      {cat.emoji}
                    </span>
                    <div>
                      <h3 className="font-display text-2xl font-bold text-crust-50">{cat.label}</h3>
                      <p className="text-sm text-charcoal-300">{cat.blurb}</p>
                    </div>
                  </div>
                  <span className="text-sm text-charcoal-400">
                    {items.length} {items.length === 1 ? "item" : "items"}
                  </span>
                </div>
                <ProductGrid products={items} priorityCount={cat.id === "pizza" ? 4 : 0} />
              </motion.div>
            );
          })}
        </div>
      ) : (
        <ProductGrid products={filtered} priorityCount={4} />
      )}
    </section>
  );
}
