"use client";

import { Heart } from "lucide-react";
import { motion } from "framer-motion";
import { useFavoritesStore } from "@/lib/store/useFavoritesStore";
import { useUIStore } from "@/lib/store/useUIStore";
import { useHasMounted } from "@/lib/hooks/useHasMounted";
import { cn } from "@/lib/utils/cn";

interface FavoriteButtonProps {
  productId: string;
  productName: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}

const SIZES = {
  sm: { btn: "h-8 w-8", icon: "h-4 w-4" },
  md: { btn: "h-10 w-10", icon: "h-[18px] w-[18px]" },
  lg: { btn: "h-12 w-12", icon: "h-6 w-6" },
};

export function FavoriteButton({
  productId,
  productName,
  className,
  size = "md",
}: FavoriteButtonProps) {
  const mounted = useHasMounted();
  const isFav = useFavoritesStore((s) => s.ids.includes(productId));
  const toggle = useFavoritesStore((s) => s.toggle);
  const addToast = useUIStore((s) => s.addToast);
  const active = mounted && isFav;
  const dims = SIZES[size];

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const nowFav = toggle(productId);
    addToast({
      kind: "favorite",
      title: nowFav ? "Saved to favorites" : "Removed from favorites",
      description: productName,
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={active}
      aria-label={active ? `Remove ${productName} from favorites` : `Save ${productName} to favorites`}
      className={cn(
        "grid place-items-center rounded-full backdrop-blur transition-colors",
        "bg-charcoal-900/60 ring-1 ring-inset ring-white/10 hover:bg-charcoal-900/90",
        dims.btn,
        className
      )}
    >
      <motion.span
        key={active ? "on" : "off"}
        initial={{ scale: 0.4 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 600, damping: 15 }}
      >
        <Heart
          className={cn(
            dims.icon,
            "transition-colors",
            active ? "fill-ember-500 text-ember-500" : "text-crust-100"
          )}
        />
      </motion.span>
    </button>
  );
}
