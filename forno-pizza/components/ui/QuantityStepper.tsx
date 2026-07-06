"use client";

import { Minus, Plus } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils/cn";

interface QuantityStepperProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  size?: "sm" | "md";
  ariaLabel?: string;
}

export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 99,
  size = "md",
  ariaLabel = "Quantity",
}: QuantityStepperProps) {
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(Math.min(max, value + 1));

  const btn =
    "grid place-items-center rounded-full text-crust-50 transition-colors hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent";
  const dims = size === "sm" ? "h-7 w-7" : "h-9 w-9";

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-charcoal-900/80 p-1 ring-1 ring-inset ring-white/10",
        size === "sm" && "gap-0.5"
      )}
    >
      <button
        type="button"
        onClick={dec}
        disabled={value <= min}
        className={cn(btn, dims)}
        aria-label={`Decrease ${ariaLabel.toLowerCase()}`}
      >
        <Minus className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
      </button>
      <motion.span
        key={value}
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 22 }}
        className={cn(
          "min-w-[1.75rem] text-center font-semibold tabular-nums",
          size === "sm" ? "text-sm" : "text-base"
        )}
        aria-live="polite"
      >
        {value}
      </motion.span>
      <button
        type="button"
        onClick={inc}
        disabled={value >= max}
        className={cn(btn, dims)}
        aria-label={`Increase ${ariaLabel.toLowerCase()}`}
      >
        <Plus className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
      </button>
    </div>
  );
}
