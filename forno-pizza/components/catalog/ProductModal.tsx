"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Flame, ShoppingBag, X } from "lucide-react";
import { useUIStore } from "@/lib/store/useUIStore";
import { useAddToCart } from "@/lib/hooks/useAddToCart";
import { getProduct } from "@/lib/data/products";
import { ProductImage } from "@/components/ui/ProductImage";
import { TagPill } from "@/components/ui/TagPill";
import { SpiceMeter } from "@/components/ui/SpiceMeter";
import { FavoriteButton } from "@/components/ui/FavoriteButton";
import { SizeSelector } from "./SizeSelector";
import { ToppingsSelector } from "./ToppingsSelector";
import { QuantityStepper } from "@/components/ui/QuantityStepper";
import { Modal } from "@/components/ui/Modal";
import { formatPrice } from "@/lib/utils/format";
import { unitPriceFor } from "@/lib/utils/pricing";

export function ProductModal() {
  const quickViewId = useUIStore((s) => s.quickViewId);
  const closeQuickView = useUIStore((s) => s.closeQuickView);
  const addToCart = useAddToCart();

  const product = quickViewId ? getProduct(quickViewId) : undefined;

  const [sizeId, setSizeId] = useState<string>("");
  const [selectedToppings, setSelectedToppings] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const imageRef = useRef<HTMLDivElement>(null);

  // Reset local state whenever a different product opens.
  useEffect(() => {
    if (product) {
      setSizeId(product.sizes[0].id);
      setSelectedToppings([]);
      setQuantity(1);
    }
  }, [product]);

  const toppingObjects = useMemo(
    () => (product?.toppings ?? []).filter((t) => selectedToppings.includes(t.id)),
    [product, selectedToppings]
  );

  const size = product?.sizes.find((s) => s.id === sizeId) ?? product?.sizes[0];
  const unitPrice = size ? unitPriceFor(size.price, toppingObjects) : 0;
  const total = unitPrice * quantity;

  const toggleTopping = (id: string) =>
    setSelectedToppings((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const handleAdd = () => {
    if (!product || !size) return;
    addToCart(product, {
      sizeId: size.id,
      toppings: toppingObjects,
      quantity,
      sourceEl: imageRef.current,
    });
    closeQuickView();
  };

  return (
    <Modal open={!!product} onClose={closeQuickView} labelledBy="product-modal-title">
      {product && size && (
        <div className="flex max-h-[92vh] flex-col sm:flex-row">
          {/* Image */}
          <div
            ref={imageRef}
            className="relative aspect-[4/3] w-full flex-shrink-0 overflow-hidden sm:aspect-auto sm:w-[44%]"
          >
            <ProductImage
              src={product.image}
              alt={product.name}
              category={product.category}
              priority
              sizes="(max-width: 640px) 100vw, 40vw"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-charcoal-950/60 to-transparent sm:bg-gradient-to-r" />
            <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
              {product.tags.map((tag) => (
                <TagPill key={tag} tag={tag} />
              ))}
            </div>
          </div>

          {/* Details */}
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-white/5 p-5 pb-4">
              <div>
                <h2
                  id="product-modal-title"
                  className="font-display text-2xl font-bold text-crust-50"
                >
                  {product.name}
                </h2>
                <div className="mt-1.5 flex items-center gap-3 text-sm text-charcoal-300">
                  {product.kcal != null && <span>{product.kcal} kcal</span>}
                  <SpiceMeter level={product.spiceLevel ?? 0} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <FavoriteButton productId={product.id} productName={product.name} />
                <button
                  type="button"
                  onClick={closeQuickView}
                  aria-label="Close"
                  className="grid h-10 w-10 place-items-center rounded-full bg-white/5 text-crust-100 transition-colors hover:bg-white/10"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              <p className="text-sm leading-relaxed text-charcoal-200">
                {product.longDescription ?? product.description}
              </p>

              {/* Ingredients */}
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-charcoal-400">
                  Ingredients
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {product.ingredients.map((ing) => (
                    <span
                      key={ing}
                      className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-crust-100 ring-1 ring-inset ring-white/5"
                    >
                      {ing}
                    </span>
                  ))}
                </div>
              </div>

              {/* Sizes */}
              {product.sizes.length > 1 && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-charcoal-400">
                    Choose your size
                  </h3>
                  <SizeSelector sizes={product.sizes} value={sizeId} onChange={setSizeId} />
                </div>
              )}

              {/* Toppings */}
              {product.toppings && product.toppings.length > 0 && (
                <div>
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-charcoal-400">
                    <Flame className="h-3.5 w-3.5 text-flame-400" />
                    Add extra toppings
                  </h3>
                  <ToppingsSelector
                    toppings={product.toppings}
                    selected={selectedToppings}
                    onToggle={toggleTopping}
                  />
                </div>
              )}
            </div>

            {/* Footer / add to cart */}
            <div className="flex items-center gap-3 border-t border-white/5 bg-charcoal-900/80 p-4">
              <QuantityStepper value={quantity} onChange={setQuantity} />
              <button type="button" onClick={handleAdd} className="btn btn-primary h-12 flex-1 px-5 text-base">
                <ShoppingBag className="h-5 w-5" />
                Add to cart
                <motion.span
                  key={total}
                  initial={{ scale: 0.7, opacity: 0.6 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="ml-1 tabular-nums"
                >
                  · {formatPrice(total)}
                </motion.span>
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
