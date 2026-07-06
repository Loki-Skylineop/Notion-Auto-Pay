"use client";

import Image from "next/image";
import { useState } from "react";
import type { Category } from "@/types";
import { cn } from "@/lib/utils/cn";

const FALLBACK: Record<Category, { emoji: string; from: string; to: string }> = {
  pizza: { emoji: "🍕", from: "from-ember-500/40", to: "to-flame-500/30" },
  drinks: { emoji: "🥤", from: "from-flame-500/40", to: "to-gold-400/25" },
  desserts: { emoji: "🍰", from: "from-gold-400/40", to: "to-ember-400/25" },
};

interface ProductImageProps {
  src: string;
  alt: string;
  category: Category;
  className?: string;
  sizes?: string;
  priority?: boolean;
}

/**
 * next/image wrapper that always fills its (positioned) parent and degrades to
 * a styled gradient + emoji placeholder if the remote photo fails to load.
 */
export function ProductImage({
  src,
  alt,
  category,
  className,
  sizes = "(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw",
  priority = false,
}: ProductImageProps) {
  const [errored, setErrored] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fb = FALLBACK[category];

  if (errored) {
    return (
      <div
        className={cn(
          "grid h-full w-full place-items-center bg-gradient-to-br",
          fb.from,
          fb.to,
          className
        )}
        role="img"
        aria-label={alt}
      >
        <span className="text-6xl drop-shadow-lg" aria-hidden>
          {fb.emoji}
        </span>
      </div>
    );
  }

  return (
    <>
      {!loaded && <div className="skeleton absolute inset-0" aria-hidden />}
      <Image
        src={src}
        alt={alt}
        fill
        sizes={sizes}
        priority={priority}
        onError={() => setErrored(true)}
        onLoad={() => setLoaded(true)}
        className={cn(
          "object-cover transition-opacity duration-500",
          loaded ? "opacity-100" : "opacity-0",
          className
        )}
      />
    </>
  );
}
