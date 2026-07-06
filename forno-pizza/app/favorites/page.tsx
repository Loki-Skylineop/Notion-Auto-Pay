import type { Metadata } from "next";
import { FavoritesList } from "@/components/profile/FavoritesList";

export const metadata: Metadata = {
  title: "Favorites",
  description: "Your saved favorite pizzas, drinks and desserts.",
};

export default function FavoritesPage() {
  return (
    <div className="container-page py-12 sm:py-16">
      <header className="mb-8">
        <span className="text-sm font-semibold uppercase tracking-[0.2em] text-flame-400">
          Saved for later
        </span>
        <h1 className="mt-2 font-display text-4xl font-bold text-crust-50">Your favorites</h1>
        <p className="mt-2 text-charcoal-300">
          Everything you&apos;ve hearted, in one place.
        </p>
      </header>
      <FavoritesList />
    </div>
  );
}
