"use client";

import { motion } from "framer-motion";
import type { Category } from "@/types";
import { CATEGORIES } from "@/lib/utils/constants";
import { cn } from "@/lib/utils/cn";

export type CategoryFilter = Category | "all";

const TABS: { id: CategoryFilter; label: string; emoji: string }[] = [
  { id: "all", label: "All", emoji: "✨" },
  ...CATEGORIES.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji })),
];

interface CategoryTabsProps {
  value: CategoryFilter;
  onChange: (value: CategoryFilter) => void;
}

export function CategoryTabs({ value, onChange }: CategoryTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Menu categories"
      className="no-scrollbar flex gap-2 overflow-x-auto pb-1"
    >
      {TABS.map((tab) => {
        const active = value === tab.id;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative flex-shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              active ? "text-white" : "text-charcoal-300 hover:text-crust-50"
            )}
          >
            {active && (
              <motion.span
                layoutId="category-pill"
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
                className="absolute inset-0 rounded-full bg-flame-gradient shadow-[0_6px_18px_-6px_rgba(226,59,46,0.6)]"
              />
            )}
            <span className="relative z-10">
              <span className="mr-1.5" aria-hidden>
                {tab.emoji}
              </span>
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
