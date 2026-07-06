"use client";

import { Check, Plus } from "lucide-react";
import type { Topping } from "@/types";
import { formatPrice } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

interface ToppingsSelectorProps {
  toppings: Topping[];
  selected: string[];
  onToggle: (toppingId: string) => void;
}

export function ToppingsSelector({ toppings, selected, onToggle }: ToppingsSelectorProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {toppings.map((topping) => {
        const active = selected.includes(topping.id);
        return (
          <button
            key={topping.id}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(topping.id)}
            className={cn(
              "group inline-flex items-center gap-1.5 rounded-full py-1.5 pl-2.5 pr-3 text-sm transition-all",
              "ring-1 ring-inset",
              active
                ? "bg-flame-500/15 text-flame-200 ring-flame-400/40"
                : "bg-white/[0.03] text-crust-100 ring-white/10 hover:ring-white/25"
            )}
          >
            <span
              className={cn(
                "grid h-4 w-4 place-items-center rounded-full transition-colors",
                active ? "bg-flame-500 text-white" : "bg-white/10 text-charcoal-300"
              )}
            >
              {active ? <Check className="h-3 w-3" strokeWidth={3} /> : <Plus className="h-3 w-3" strokeWidth={3} />}
            </span>
            {topping.name}
            <span className={cn("text-xs", active ? "text-flame-300" : "text-charcoal-400")}>
              +{formatPrice(topping.price)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
