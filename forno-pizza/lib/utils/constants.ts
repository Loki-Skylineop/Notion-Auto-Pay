import type { Category } from "@/types";

export const BRAND = {
  name: "Forno",
  tagline: "Wood-fired since day one",
  phone: "+1 (415) 555-0132",
  email: "ciao@forno.pizza",
  address: "27 Marconi Street, San Francisco, CA",
  hours: "Mon–Sun · 11:00 – 23:00",
} as const;

export const DELIVERY_FEE = 3.5;
/** Orders at or above this subtotal ship free. */
export const FREE_DELIVERY_THRESHOLD = 35;

export interface CategoryMeta {
  id: Category;
  label: string;
  blurb: string;
  emoji: string;
}

export const CATEGORIES: CategoryMeta[] = [
  { id: "pizza", label: "Pizza", blurb: "Hand-stretched, wood-fired", emoji: "🍕" },
  { id: "drinks", label: "Drinks", blurb: "Chilled & refreshing", emoji: "🥤" },
  { id: "desserts", label: "Desserts", blurb: "Sweet Italian endings", emoji: "🍰" },
];

/** Compute delivery fee for a given subtotal (free above the threshold). */
export function deliveryFeeFor(subtotal: number): number {
  if (subtotal <= 0) return 0;
  return subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE;
}
