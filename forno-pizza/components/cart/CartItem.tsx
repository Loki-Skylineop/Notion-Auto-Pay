"use client";

import { motion } from "framer-motion";
import { Trash2 } from "lucide-react";
import type { CartLine } from "@/types";
import { ProductImage } from "@/components/ui/ProductImage";
import { QuantityStepper } from "@/components/ui/QuantityStepper";
import { useCartStore } from "@/lib/store/useCartStore";
import { formatPrice } from "@/lib/utils/format";
import { lineTotal } from "@/lib/utils/pricing";

export function CartItem({ line }: { line: CartLine }) {
  const setQuantity = useCartStore((s) => s.setQuantity);
  const removeLine = useCartStore((s) => s.removeLine);

  const toppingSummary = line.toppings.map((t) => t.name).join(", ");

  return (
    <motion.li
      layout
      initial={{ opacity: 0, height: 0, marginTop: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, x: 40, height: 0, marginTop: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 34 }}
      className="flex gap-3 overflow-hidden py-4"
    >
      <div className="relative h-20 w-20 flex-shrink-0 overflow-hidden rounded-2xl ring-1 ring-inset ring-white/10">
        <ProductImage
          src={line.image}
          alt={line.name}
          category={line.category}
          sizes="80px"
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 className="truncate font-semibold text-crust-50">{line.name}</h4>
            {line.sizeLabel && line.sizeId !== "regular" && (
              <p className="text-xs text-charcoal-300">{line.sizeLabel}</p>
            )}
            {toppingSummary && (
              <p className="mt-0.5 line-clamp-1 text-xs text-charcoal-400">+ {toppingSummary}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => removeLine(line.lineId)}
            aria-label={`Remove ${line.name} from cart`}
            className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full text-charcoal-400 transition-colors hover:bg-ember-500/15 hover:text-ember-300"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-auto flex items-center justify-between pt-2">
          <QuantityStepper
            value={line.quantity}
            onChange={(q) => setQuantity(line.lineId, q)}
            min={1}
            size="sm"
            ariaLabel={`${line.name} quantity`}
          />
          <span className="font-semibold tabular-nums text-gold-300">
            {formatPrice(lineTotal(line))}
          </span>
        </div>
      </div>
    </motion.li>
  );
}
