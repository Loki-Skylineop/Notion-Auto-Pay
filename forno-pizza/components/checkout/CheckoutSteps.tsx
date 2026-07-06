"use client";

import { Check } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils/cn";

const STEPS = ["Delivery", "Payment", "Review"];

export function CheckoutSteps({ current }: { current: number }) {
  return (
    <ol className="flex items-center">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex items-center gap-2.5">
              <div
                className={cn(
                  "relative grid h-9 w-9 flex-shrink-0 place-items-center rounded-full text-sm font-bold transition-colors",
                  done && "bg-basil-500 text-white",
                  active && "bg-flame-gradient text-white",
                  !done && !active && "bg-white/5 text-charcoal-300 ring-1 ring-inset ring-white/10"
                )}
              >
                {done ? <Check className="h-4 w-4" strokeWidth={3} /> : i + 1}
                {active && (
                  <motion.span
                    layoutId="step-glow"
                    className="absolute inset-0 -z-10 rounded-full bg-flame-500/40 blur-md"
                  />
                )}
              </div>
              <span
                className={cn(
                  "hidden text-sm font-semibold sm:block",
                  active ? "text-crust-50" : done ? "text-basil-400" : "text-charcoal-400"
                )}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className="mx-3 h-px flex-1 bg-white/10">
                <div
                  className={cn("h-full bg-basil-500 transition-all duration-500", done ? "w-full" : "w-0")}
                />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
