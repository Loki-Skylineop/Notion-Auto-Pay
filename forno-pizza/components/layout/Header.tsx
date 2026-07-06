"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Heart, Pizza, Search, ShoppingBag, User } from "lucide-react";
import { useUIStore } from "@/lib/store/useUIStore";
import { useCartStore } from "@/lib/store/useCartStore";
import { useFavoritesStore } from "@/lib/store/useFavoritesStore";
import { useCatalogStore } from "@/lib/store/useCatalogStore";
import { useHasMounted } from "@/lib/hooks/useHasMounted";
import { cartCount } from "@/lib/utils/pricing";
import { CATEGORIES, BRAND } from "@/lib/utils/constants";
import type { CategoryFilter } from "@/components/catalog/CategoryTabs";
import { cn } from "@/lib/utils/cn";

function CountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <motion.span
      key={count}
      initial={{ scale: 0.4 }}
      animate={{ scale: 1 }}
      transition={{ type: "spring", stiffness: 600, damping: 16 }}
      className={cn(
        "absolute -right-1 -top-1 grid h-5 min-w-[20px] place-items-center rounded-full bg-flame-gradient px-1 text-[11px] font-bold text-white ring-2 ring-charcoal-950",
        className
      )}
    >
      {count > 99 ? "99+" : count}
    </motion.span>
  );
}

export function Header() {
  const mounted = useHasMounted();
  const pathname = usePathname();
  const openCart = useUIStore((s) => s.openCart);
  const cartPulseKey = useUIStore((s) => s.cartPulseKey);
  const count = useCartStore((s) => cartCount(s.lines));
  const favCount = useFavoritesStore((s) => s.ids.length);
  const setCategory = useCatalogStore((s) => s.setCategory);

  const goToCategory = (category: CategoryFilter) => {
    setCategory(category);
    if (pathname === "/") {
      document.getElementById("menu")?.scrollIntoView({ behavior: "smooth" });
    }
  };

  const focusSearch = () => {
    setCategory("all");
    setTimeout(() => {
      const el = document.getElementById("menu-search") as HTMLInputElement | null;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus();
    }, 350);
  };

  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-charcoal-950/80 backdrop-blur-lg">
      <div className="container-page flex h-[var(--header-height)] items-center justify-between gap-4">
        {/* Logo */}
        <Link href="/" className="flex flex-shrink-0 items-center gap-2.5" aria-label={`${BRAND.name} home`}>
          <span className="grid h-10 w-10 place-items-center rounded-2xl bg-flame-gradient shadow-[0_6px_16px_-6px_rgba(226,59,46,0.7)]">
            <Pizza className="h-6 w-6 text-white" />
          </span>
          <span className="font-display text-2xl font-bold tracking-tight text-crust-50">
            {BRAND.name}
          </span>
        </Link>

        {/* Category nav */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="Menu categories">
          <Link
            href="/#menu"
            onClick={() => goToCategory("all")}
            className="rounded-full px-3.5 py-2 text-sm font-medium text-charcoal-200 transition-colors hover:bg-white/5 hover:text-crust-50"
          >
            Menu
          </Link>
          {CATEGORIES.map((cat) => (
            <Link
              key={cat.id}
              href="/#menu"
              onClick={() => goToCategory(cat.id)}
              className="rounded-full px-3.5 py-2 text-sm font-medium text-charcoal-200 transition-colors hover:bg-white/5 hover:text-crust-50"
            >
              {cat.label}
            </Link>
          ))}
        </nav>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={focusSearch}
            aria-label="Search the menu"
            className="grid h-10 w-10 place-items-center rounded-full text-crust-100 transition-colors hover:bg-white/5"
          >
            <Search className="h-[22px] w-[22px]" />
          </button>

          <Link
            href="/favorites"
            aria-label={`Favorites${mounted && favCount ? `, ${favCount} saved` : ""}`}
            className={cn(
              "relative grid h-10 w-10 place-items-center rounded-full transition-colors hover:bg-white/5",
              pathname === "/favorites" ? "text-ember-400" : "text-crust-100"
            )}
          >
            <Heart className="h-[22px] w-[22px]" />
            {mounted && <CountBadge count={favCount} />}
          </Link>

          <Link
            href="/account"
            aria-label="Your profile"
            className={cn(
              "grid h-10 w-10 place-items-center rounded-full transition-colors hover:bg-white/5",
              pathname === "/account" ? "text-flame-400" : "text-crust-100"
            )}
          >
            <User className="h-[22px] w-[22px]" />
          </Link>

          <button
            id="cart-anchor"
            type="button"
            onClick={openCart}
            aria-label={`Open cart${mounted && count ? `, ${count} items` : ""}`}
            className="relative ml-1 grid h-11 w-11 place-items-center rounded-full bg-white/5 text-crust-50 ring-1 ring-inset ring-white/10 transition-colors hover:bg-white/10"
          >
            <motion.span
              key={cartPulseKey}
              animate={cartPulseKey ? { scale: [1, 1.28, 1] } : undefined}
              transition={{ duration: 0.4 }}
            >
              <ShoppingBag className="h-[22px] w-[22px]" />
            </motion.span>
            {mounted && <CountBadge count={count} />}
          </button>
        </div>
      </div>
    </header>
  );
}
