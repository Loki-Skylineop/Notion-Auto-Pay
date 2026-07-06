"use client";

import { motion } from "framer-motion";
import type { SizeOption } from "@/types";
import { formatPrice } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

interface SizeSelectorProps {
  sizes: SizeOption[];
  value: string;
  onChange: (sizeId: string) => void;
  /** Unique id so multiple selectors don't share the same layout animation. */
  groupId?: string;
}

export function SizeSelector({ sizes, value, onChange, groupId = "size" }: SizeSelectorProps) {
  if (sizes.length <= 1) return null;

  return (
    <div
      role="radiogroup"
      aria-label="Choose a size"
      className={cn("grid gap-2", sizes.length === 2 ? "grid-cols-2" : "grid-cols-3")}
    >
      {sizes.map((size) => {
        const active = size.id === value;
        return (
          <button
            key={size.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(size.id)}
            className={cn(
              "relative overflow-hidden rounded-2xl px-3 py-3 text-center transition-colors duration-200",
              "ring-1 ring-inset",
              active ? "ring-transparent" : "ring-white/10 hover:ring-white/25"
            )}
          >
            {active && (
              <motion.span
                layoutId={`${groupId}-active`}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="absolute inset-0 bg-flame-gradient"
              />
            )}
            <span className="relative z-10 block">
              <span
                className={cn(
                  "block font-display text-base font-semibold",
                  active ? "text-white" : "text-crust-50"
                )}
              >
                {size.label}
              </span>
              {size.sublabel && (
                <span
                  className={cn(
                    "block text-[11px] uppercase tracking-wide",
                    active ? "text-white/80" : "text-charcoal-400"
                  )}
                >
                  {size.sublabel}
                </span>
              )}
              <span
                className={cn(
                  "mt-1 block text-sm font-semibold tabular-nums",
                  active ? "text-white" : "text-gold-300"
                )}
              >
                {formatPrice(size.price)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
