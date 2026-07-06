import Link from "next/link";
import { Home, UtensilsCrossed } from "lucide-react";

export default function NotFound() {
  return (
    <div className="container-page flex min-h-[70vh] flex-col items-center justify-center py-20 text-center">
      <div className="relative mb-6">
        <div className="absolute inset-0 -z-10 animate-pulse rounded-full bg-flame-500/20 blur-3xl" />
        <span className="text-8xl" aria-hidden>
          🍕
        </span>
      </div>
      <p className="font-display text-6xl font-bold text-crust-50">404</p>
      <h1 className="mt-3 font-display text-2xl font-semibold text-crust-50">
        This slice went missing
      </h1>
      <p className="mt-2 max-w-md text-charcoal-300">
        The page you&apos;re looking for isn&apos;t on the menu. Let&apos;s get you back to
        something delicious.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/" className="btn btn-primary px-6 py-3">
          <Home className="h-5 w-5" />
          Back home
        </Link>
        <Link href="/#menu" className="btn btn-outline px-6 py-3">
          <UtensilsCrossed className="h-5 w-5" />
          See the menu
        </Link>
      </div>
    </div>
  );
}
