"use client";

import { useRef } from "react";
import { motion } from "framer-motion";
import { Plus } from "lucide-react";
import type { Product } from "@/types";
import { ProductImage } from "@/components/ui/ProductImage";
import { TagPill } from "@/components/ui/TagPill";
import { SpiceMeter } from "@/components/ui/SpiceMeter";
import { FavoriteButton } from "@/components/ui/FavoriteButton";
import { useUIStore } from "@/lib/store/useUIStore";
import { useAddToCart } from "@/lib/hooks/useAddToCart";
import { formatPrice } from "@/lib/utils/format";

export function ProductCard({ product, priority = false }: { product: Product; priority?: boolean }) {
  const openQuickView = useUIStore((s) => s.openQuickView);
  const addToCart = useAddToCart();
  const imageRef = useRef<HTMLDivElement>(null);

  const minPrice = Math.min(...product.sizes.map((s) => s.price));
  const hasSizes = product.sizes.length > 1;

  const handleQuickAdd = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    addToCart(product, {
      sizeId: product.sizes[0].id,
      quantity: 1,
      sourceEl: imageRef.current,
    });
  };

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
      whileHover={{ y: -6 }}
      className="group relative flex flex-col overflow-hidden rounded-3xl bg-charcoal-850 shadow-card ring-1 ring-inset ring-white/5 transition-shadow duration-300 hover:shadow-card-hover hover:ring-flame-500/20"
    >
      {/* Media */}
      <div ref={imageRef} className="relative aspect-[4/3] overflow-hidden">
        <div className="h-full w-full transition-transform duration-700 ease-out group-hover:scale-[1.09]">
          <ProductImage
            src={product.image}
            alt={product.name}
            category={product.category}
            priority={priority}
          />
        </div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-charcoal-950/70 via-transparent to-transparent" />

        {/* Tags */}
        <div className="absolute left-3 top-3 z-20 flex max-w-[75%] flex-wrap gap-1.5">
          {product.tags.slice(0, 2).map((tag) => (
            <TagPill key={tag} tag={tag} />
          ))}
        </div>

        {/* Favorite */}
        <div className="absolute right-3 top-3 z-20">
          <FavoriteButton productId={product.id} productName={product.name} size="sm" />
        </div>

        {/* Quick add (revealed on hover) */}
        <motion.button
          type="button"
          onClick={handleQuickAdd}
          whileTap={{ scale: 0.9 }}
          aria-label={`Quick add ${product.name} to cart`}
          className="absolute bottom-3 right-3 z-20 grid h-11 w-11 translate-y-2 place-items-center rounded-full bg-flame-gradient text-white opacity-0 shadow-glow transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100"
        >
          <Plus className="h-5 w-5" strokeWidth={2.5} />
        </motion.button>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-4">
        <div className="mb-1 flex items-start justify-between gap-2">
          <h3 className="font-display text-lg font-semibold leading-tight text-crust-50">
            {product.name}
          </h3>
          <SpiceMeter level={product.spiceLevel ?? 0} className="mt-1 flex-shrink-0" />
        </div>
        <p className="line-clamp-2 text-sm text-charcoal-300">{product.description}</p>

        <div className="mt-auto flex items-end justify-between pt-4">
          <div>
            {hasSizes && (
              <span className="block text-[11px] uppercase tracking-wide text-charcoal-400">
                from
              </span>
            )}
            <span className="font-display text-xl font-semibold text-gold-300">
              {formatPrice(minPrice)}
            </span>
          </div>
          <span className="text-xs font-medium text-flame-300 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            View details →
          </span>
        </div>
      </div>

      {/* Stretched click target → quick view (keyboard accessible) */}
      <button
        type="button"
        onClick={() => openQuickView(product.id)}
        aria-label={`View details for ${product.name}`}
        className="absolute inset-0 z-10 rounded-3xl"
      />
    </motion.article>
  );
}
