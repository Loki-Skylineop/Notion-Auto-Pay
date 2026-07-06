"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Clock, Star, Flame, ArrowRight } from "lucide-react";
import { ProductImage } from "@/components/ui/ProductImage";
import { getProduct } from "@/lib/data/products";
import { BRAND } from "@/lib/utils/constants";

const heroPizza = getProduct("napoletana")!;

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } },
};
const item = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 26 } },
};

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-warm-radial">
      {/* Decorative glow */}
      <div className="pointer-events-none absolute -right-24 top-10 h-96 w-96 rounded-full bg-flame-500/20 blur-[100px]" />
      <div className="pointer-events-none absolute -left-24 bottom-0 h-80 w-80 rounded-full bg-ember-600/20 blur-[100px]" />

      <div className="container-page relative grid items-center gap-10 py-16 sm:py-20 lg:grid-cols-2 lg:py-28">
        {/* Copy */}
        <motion.div variants={container} initial="hidden" animate="show" className="text-center lg:text-left">
          <motion.span
            variants={item}
            className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3.5 py-1.5 text-xs font-semibold text-flame-300 ring-1 ring-inset ring-white/10"
          >
            <Flame className="h-3.5 w-3.5" />
            {BRAND.tagline}
          </motion.span>

          <motion.h1
            variants={item}
            className="mt-5 font-display text-5xl font-bold leading-[1.02] tracking-tight text-crust-50 sm:text-6xl lg:text-7xl"
          >
            Naples in a box,
            <span className="block bg-gradient-to-r from-flame-400 via-ember-400 to-gold-300 bg-clip-text text-transparent">
              at your door in 30′
            </span>
          </motion.h1>

          <motion.p variants={item} className="mx-auto mt-5 max-w-md text-lg text-charcoal-200 lg:mx-0">
            Slow-fermented dough, San Marzano tomatoes and a blazing wood oven.
            Handmade pizza, drinks and dolci — delivered hot.
          </motion.p>

          <motion.div variants={item} className="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            <Link href="#menu" className="btn btn-primary px-6 py-3.5 text-base">
              Order now
              <ArrowRight className="h-5 w-5" />
            </Link>
            <Link href="#menu" className="btn btn-outline px-6 py-3.5 text-base">
              Explore the menu
            </Link>
          </motion.div>

          <motion.dl variants={item} className="mt-10 flex items-center justify-center gap-6 lg:justify-start">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-flame-400" />
              <div className="text-left">
                <dt className="text-lg font-bold text-crust-50">~30 min</dt>
                <dd className="text-xs text-charcoal-400">avg delivery</dd>
              </div>
            </div>
            <span className="h-8 w-px bg-white/10" />
            <div className="flex items-center gap-2">
              <Star className="h-5 w-5 fill-gold-400 text-gold-400" />
              <div className="text-left">
                <dt className="text-lg font-bold text-crust-50">4.9</dt>
                <dd className="text-xs text-charcoal-400">2,300+ reviews</dd>
              </div>
            </div>
            <span className="hidden h-8 w-px bg-white/10 sm:block" />
            <div className="hidden items-center gap-2 sm:flex">
              <Flame className="h-5 w-5 text-ember-400" />
              <div className="text-left">
                <dt className="text-lg font-bold text-crust-50">Wood-fired</dt>
                <dd className="text-xs text-charcoal-400">every single pie</dd>
              </div>
            </div>
          </motion.dl>
        </motion.div>

        {/* Floating pizza */}
        <motion.div
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 120, damping: 18, delay: 0.15 }}
          className="relative mx-auto aspect-square w-full max-w-md"
        >
          <div className="absolute inset-6 rounded-full bg-flame-gradient opacity-30 blur-3xl" />
          <div className="animate-float">
            <div className="relative aspect-square w-full overflow-hidden rounded-full ring-4 ring-white/10 shadow-[0_40px_80px_-20px_rgba(0,0,0,0.6)]">
              <div className="animate-spin-slow">
                <div className="relative aspect-square w-full">
                  <ProductImage
                    src={heroPizza.image}
                    alt="A freshly wood-fired pizza"
                    category="pizza"
                    priority
                    sizes="(max-width: 1024px) 90vw, 40vw"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Floating badges */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="absolute -left-2 top-8 flex items-center gap-2 rounded-2xl bg-charcoal-800/90 px-3.5 py-2.5 shadow-drawer ring-1 ring-inset ring-white/10 backdrop-blur sm:left-4"
          >
            <span className="text-2xl" aria-hidden>🔥</span>
            <div>
              <p className="text-sm font-semibold text-crust-50">Fresh from the oven</p>
              <p className="text-xs text-charcoal-300">Baked at 450°C</p>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8 }}
            className="absolute -bottom-2 right-2 flex items-center gap-2 rounded-2xl bg-charcoal-800/90 px-3.5 py-2.5 shadow-drawer ring-1 ring-inset ring-white/10 backdrop-blur sm:right-6"
          >
            <span className="text-2xl" aria-hidden>🍅</span>
            <div>
              <p className="text-sm font-semibold text-crust-50">100% San Marzano</p>
              <p className="text-xs text-charcoal-300">Slow-cooked sauce</p>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
