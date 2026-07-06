"use client";

import Link from "next/link";
import type { Product } from "@/types";
import { useFavoritesStore } from "@/lib/store/useFavoritesStore";
import { useHasMounted } from "@/lib/hooks/useHasMounted";
import { getProduct } from "@/lib/data/products";
import { ProductGrid } from "@/components/catalog/ProductGrid";
import { ProductCardSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

export function FavoritesList() {
  const mounted = useHasMounted();
  const ids = useFavoritesStore((s) => s.ids);
  const items = ids
    .map((id) => getProduct(id))
    .filter((p): p is Product => Boolean(p));

  if (!mounted) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        emoji="💛"
        title="No favorites yet"
        description="Tap the heart on any dish to save it here for next time."
        action={
          <Link href="/#menu" className="btn btn-primary px-5 py-2.5">
            Browse the menu
          </Link>
        }
      />
    );
  }

  return <ProductGrid products={items} />;
}
