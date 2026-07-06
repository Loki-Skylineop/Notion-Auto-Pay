"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Heart, MapPin, Receipt, UserRound } from "lucide-react";
import { useOrdersStore } from "@/lib/store/useOrdersStore";
import { useFavoritesStore } from "@/lib/store/useFavoritesStore";
import { useProfileStore } from "@/lib/store/useProfileStore";
import { useHasMounted } from "@/lib/hooks/useHasMounted";
import { OrderHistory } from "./OrderHistory";
import { SavedDetails } from "./SavedDetails";
import { FavoritesList } from "./FavoritesList";
import { ResetData } from "./ResetData";
import { cn } from "@/lib/utils/cn";

type TabId = "orders" | "details" | "favorites";

const TABS: { id: TabId; label: string; icon: typeof Receipt }[] = [
  { id: "orders", label: "Orders", icon: Receipt },
  { id: "details", label: "Details", icon: MapPin },
  { id: "favorites", label: "Favorites", icon: Heart },
];

export function ProfilePanel() {
  const mounted = useHasMounted();
  const [tab, setTab] = useState<TabId>("orders");
  const orderCount = useOrdersStore((s) => s.orders.length);
  const favCount = useFavoritesStore((s) => s.ids.length);
  const displayName = useProfileStore((s) => s.displayName);

  const greeting = mounted && displayName ? displayName.split(" ")[0] : "there";

  return (
    <div className="container-page py-10 sm:py-14">
      {/* Header */}
      <div className="surface flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span className="grid h-16 w-16 flex-shrink-0 place-items-center rounded-3xl bg-flame-gradient text-white shadow-glow">
            <UserRound className="h-8 w-8" />
          </span>
          <div>
            <h1 className="font-display text-2xl font-bold text-crust-50 sm:text-3xl">
              Ciao, {greeting}! 👋
            </h1>
            <p className="mt-1 text-sm text-charcoal-300">
              Your profile lives on this device — no account or password needed.
            </p>
          </div>
        </div>
        <dl className="flex gap-6 sm:gap-8">
          <div className="text-center">
            <dt className="text-xs uppercase tracking-wide text-charcoal-400">Orders</dt>
            <dd className="font-display text-2xl font-bold text-crust-50">
              {mounted ? orderCount : "—"}
            </dd>
          </div>
          <div className="text-center">
            <dt className="text-xs uppercase tracking-wide text-charcoal-400">Favorites</dt>
            <dd className="font-display text-2xl font-bold text-crust-50">
              {mounted ? favCount : "—"}
            </dd>
          </div>
        </dl>
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Profile sections"
        className="no-scrollbar mt-6 flex gap-1 overflow-x-auto rounded-full bg-charcoal-900/60 p-1 ring-1 ring-inset ring-white/5"
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={cn(
                "relative flex flex-1 items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors",
                active ? "text-white" : "text-charcoal-300 hover:text-crust-50"
              )}
            >
              {active && (
                <motion.span
                  layoutId="profile-tab"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                  className="absolute inset-0 rounded-full bg-flame-gradient"
                />
              )}
              <span className="relative z-10 flex items-center gap-2">
                <Icon className="h-4 w-4" />
                {t.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="mt-6">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
        >
          {tab === "orders" && <OrderHistory />}
          {tab === "details" && <SavedDetails />}
          {tab === "favorites" && <FavoritesList />}
        </motion.div>
      </div>

      {/* Danger zone */}
      <div className="mt-10">
        <ResetData />
      </div>
    </div>
  );
}
