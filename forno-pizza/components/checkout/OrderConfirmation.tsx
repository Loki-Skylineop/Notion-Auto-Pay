"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Check, Clock, MapPin, Receipt } from "lucide-react";
import type { Order } from "@/types";
import { formatPrice } from "@/lib/utils/format";

export function OrderConfirmation({ order, etaLabel }: { order: Order; etaLabel: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-lg text-center"
    >
      {/* Success mark */}
      <div className="relative mx-auto mb-6 h-24 w-24">
        <motion.span
          className="absolute inset-0 rounded-full bg-basil-500/30 blur-xl"
          initial={{ scale: 0 }}
          animate={{ scale: [0, 1.4, 1] }}
          transition={{ duration: 0.7 }}
        />
        <motion.div
          className="relative grid h-24 w-24 place-items-center rounded-full bg-basil-500 text-white"
          initial={{ scale: 0, rotate: -30 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 16, delay: 0.1 }}
        >
          <motion.span
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.35 }}
          >
            <Check className="h-12 w-12" strokeWidth={3} />
          </motion.span>
        </motion.div>
      </div>

      <h1 className="font-display text-3xl font-bold text-crust-50">Order confirmed!</h1>
      <p className="mt-2 text-charcoal-200">
        Thanks{order.delivery.name ? `, ${order.delivery.name.split(" ")[0]}` : ""} — your pizza is
        heading to the oven. 🍕
      </p>

      <div className="surface mt-7 space-y-4 p-6 text-left">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm text-charcoal-300">
            <Receipt className="h-4 w-4 text-flame-400" />
            Order number
          </span>
          <span className="font-display text-lg font-bold text-gold-300">{order.id}</span>
        </div>
        <div className="flex items-center justify-between border-t border-white/5 pt-4">
          <span className="flex items-center gap-2 text-sm text-charcoal-300">
            <Clock className="h-4 w-4 text-flame-400" />
            Estimated delivery
          </span>
          <span className="font-medium text-crust-50">{etaLabel}</span>
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-white/5 pt-4">
          <span className="flex items-center gap-2 text-sm text-charcoal-300">
            <MapPin className="h-4 w-4 text-flame-400" />
            Delivering to
          </span>
          <span className="max-w-[60%] text-right text-sm font-medium text-crust-50">
            {order.delivery.address}
          </span>
        </div>
        <div className="flex items-center justify-between border-t border-white/5 pt-4">
          <span className="text-sm text-charcoal-300">Total paid</span>
          <span className="font-display text-xl font-bold text-gold-300">
            {formatPrice(order.total)}
          </span>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
        <Link href="/account" className="btn btn-primary px-6 py-3">
          Track your order
        </Link>
        <Link href="/#menu" className="btn btn-outline px-6 py-3">
          Back to menu
        </Link>
      </div>
    </motion.div>
  );
}
