"use client";

import { motion } from "framer-motion";
import { Truck, Leaf, Timer, BadgePercent } from "lucide-react";
import { FREE_DELIVERY_THRESHOLD } from "@/lib/utils/constants";
import { formatPrice } from "@/lib/utils/format";

const props = [
  { icon: Timer, title: "~30 min delivery", desc: "Hot to your door, fast" },
  { icon: Leaf, title: "Fresh daily", desc: "Dough made every morning" },
  {
    icon: Truck,
    title: "Free delivery",
    desc: `On orders over ${formatPrice(FREE_DELIVERY_THRESHOLD)}`,
  },
  { icon: BadgePercent, title: "No hidden fees", desc: "The price you see is final" },
];

export function ValueProps() {
  return (
    <section className="border-y border-white/5 bg-charcoal-900/40">
      <div className="container-page grid grid-cols-2 gap-4 py-6 lg:grid-cols-4">
        {props.map((p, i) => (
          <motion.div
            key={p.title}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-40px" }}
            transition={{ delay: i * 0.06, type: "spring", stiffness: 240, damping: 24 }}
            className="flex items-center gap-3"
          >
            <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-2xl bg-flame-500/10 text-flame-400 ring-1 ring-inset ring-flame-500/20">
              <p.icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-crust-50">{p.title}</p>
              <p className="truncate text-xs text-charcoal-300">{p.desc}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
