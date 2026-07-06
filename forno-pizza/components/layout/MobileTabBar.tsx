"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Heart, ShoppingBag, User, UtensilsCrossed } from "lucide-react";
import { useUIStore } from "@/lib/store/useUIStore";
import { useCartStore } from "@/lib/store/useCartStore";
import { useFavoritesStore } from "@/lib/store/useFavoritesStore";
import { useCatalogStore } from "@/lib/store/useCatalogStore";
import { useHasMounted } from "@/lib/hooks/useHasMounted";
import { cartCount } from "@/lib/utils/pricing";
import { cn } from "@/lib/utils/cn";

export function MobileTabBar() {
  const mounted = useHasMounted();
  const pathname = usePathname();
  const openCart = useUIStore((s) => s.openCart);
  const count = useCartStore((s) => cartCount(s.lines));
  const favCount = useFavoritesStore((s) => s.ids.length);
  const setCategory = useCatalogStore((s) => s.setCategory);

  const linkCls = (active: boolean) =>
    cn(
      "relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors",
      active ? "text-flame-400" : "text-charcoal-300"
    );

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-charcoal-900/95 backdrop-blur-lg md:hidden"
      aria-label="Primary"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex items-stretch">
        <Link href="/" className={linkCls(pathname === "/")}>
          <Home className="h-5 w-5" />
          Home
        </Link>
        <Link
          href="/#menu"
          onClick={() => setCategory("all")}
          className={linkCls(false)}
        >
          <UtensilsCrossed className="h-5 w-5" />
          Menu
        </Link>
        <Link href="/favorites" className={linkCls(pathname === "/favorites")}>
          <span className="relative">
            <Heart className="h-5 w-5" />
            {mounted && favCount > 0 && (
              <span className="absolute -right-2 -top-1.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-ember-500 px-1 text-[10px] font-bold text-white">
                {favCount}
              </span>
            )}
          </span>
          Saved
        </Link>
        <button type="button" onClick={openCart} className={linkCls(false)}>
          <span className="relative">
            <ShoppingBag className="h-5 w-5" />
            {mounted && count > 0 && (
              <span className="absolute -right-2 -top-1.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-flame-gradient px-1 text-[10px] font-bold text-white">
                {count}
              </span>
            )}
          </span>
          Cart
        </button>
        <Link href="/account" className={linkCls(pathname === "/account")}>
          <User className="h-5 w-5" />
          Account
        </Link>
      </div>
    </nav>
  );
}
