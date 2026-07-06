"use client";

import { motion } from "framer-motion";

/**
 * App Router `template.tsx` re-mounts on every navigation, giving us a clean
 * fade/slide page transition between routes.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 0.61, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
