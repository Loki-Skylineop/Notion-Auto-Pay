"use client";

import { useEffect } from "react";

/** Locks body scroll while `active` is true (e.g. when a modal/drawer is open). */
export function useLockBodyScroll(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const original = document.body.style.overflow;
    const scrollbarComp = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbarComp > 0) document.body.style.paddingRight = `${scrollbarComp}px`;
    return () => {
      document.body.style.overflow = original;
      document.body.style.paddingRight = "";
    };
  }, [active]);
}
