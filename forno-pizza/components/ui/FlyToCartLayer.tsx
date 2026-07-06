"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useMemo } from "react";
import { useUIStore, type Flight } from "@/lib/store/useUIStore";

const CART_ANCHOR_ID = "cart-anchor";

function FlightItem({ flight }: { flight: Flight }) {
  const endFlight = useUIStore((s) => s.endFlight);

  // Resolve the cart icon position once, when the flight starts.
  const target = useMemo(() => {
    if (typeof document === "undefined") return { x: flight.x, y: -80 };
    const el = document.getElementById(CART_ANCHOR_ID);
    if (!el) return { x: flight.x, y: -80 };
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2 - flight.size / 2,
      y: rect.top + rect.height / 2 - flight.size / 2,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <motion.div
      initial={{ x: flight.x, y: flight.y, scale: 1, opacity: 1 }}
      animate={{
        x: target.x,
        y: [flight.y, flight.y - 120, target.y],
        scale: 0.25,
        opacity: [1, 1, 0.4],
        rotate: 220,
      }}
      transition={{ duration: 0.85, ease: [0.22, 0.61, 0.36, 1] }}
      onAnimationComplete={() => endFlight(flight.id)}
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        width: flight.size,
        height: flight.size,
        backgroundImage: `url(${flight.image})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        borderRadius: "9999px",
        zIndex: 80,
        boxShadow: "0 12px 30px -8px rgba(0,0,0,0.5)",
      }}
      aria-hidden
    />
  );
}

/** Renders the "item flies into the cart" animations. Mounted once, globally. */
export function FlyToCartLayer() {
  const flights = useUIStore((s) => s.flights);
  return (
    <div className="pointer-events-none fixed inset-0 z-[80]" aria-hidden>
      <AnimatePresence>
        {flights.map((flight) => (
          <FlightItem key={flight.id} flight={flight} />
        ))}
      </AnimatePresence>
    </div>
  );
}
