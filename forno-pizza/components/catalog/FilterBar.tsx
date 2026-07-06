"use client";

import { ArrowUpDown } from "lucide-react";
import type { SortKey, Tag } from "@/types";
import { cn } from "@/lib/utils/cn";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "popular", label: "Most popular" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "name", label: "Name: A–Z" },
];

const FILTER_TAGS: Tag[] = ["Vegetarian", "Vegan", "Spicy", "Bestseller", "New"];

interface FilterBarProps {
  sort: SortKey;
  onSortChange: (sort: SortKey) => void;
  filterTag: Tag | null;
  onFilterChange: (tag: Tag | null) => void;
}

export function FilterBar({ sort, onSortChange, filterTag, onFilterChange }: FilterBarProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {/* Dietary / quick filters */}
      <div className="no-scrollbar -mx-1 flex items-center gap-2 overflow-x-auto px-1">
        <span className="flex-shrink-0 text-xs font-semibold uppercase tracking-wider text-charcoal-400">
          Filter
        </span>
        {FILTER_TAGS.map((tag) => {
          const active = filterTag === tag;
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={active}
              onClick={() => onFilterChange(active ? null : tag)}
              className={cn(
                "flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset transition-colors",
                active
                  ? "bg-flame-500/20 text-flame-200 ring-flame-400/40"
                  : "bg-white/[0.03] text-charcoal-200 ring-white/10 hover:ring-white/25"
              )}
            >
              {tag}
            </button>
          );
        })}
      </div>

      {/* Sort */}
      <div className="relative flex flex-shrink-0 items-center">
        <ArrowUpDown
          className="pointer-events-none absolute left-3 h-4 w-4 text-charcoal-400"
          aria-hidden
        />
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          aria-label="Sort products"
          className="cursor-pointer appearance-none rounded-full border border-white/10 bg-charcoal-900/70 py-2 pl-9 pr-9 text-sm font-medium text-crust-50 transition-colors hover:border-white/25 focus:border-flame-400/60 focus:outline-none"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-charcoal-800">
              {opt.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-3.5 text-charcoal-400">▾</span>
      </div>
    </div>
  );
}
