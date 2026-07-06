import type { CartLine, Topping } from "@/types";

/** Price for a single unit = size price + all selected toppings. */
export function unitPriceFor(sizePrice: number, toppings: Topping[]): number {
  return sizePrice + toppings.reduce((sum, t) => sum + t.price, 0);
}

/** Total for a cart line = unit price × quantity. */
export function lineTotal(line: CartLine): number {
  return line.unitPrice * line.quantity;
}

/** Sum of all line totals. */
export function cartSubtotal(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0);
}

/** Total number of items (respecting quantity) in the cart. */
export function cartCount(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

/**
 * Deterministic id for a cart line so identical configurations merge and
 * different topping/size combinations stay separate.
 */
export function makeLineId(
  productId: string,
  sizeId: string,
  toppings: Topping[]
): string {
  const toppingKey = toppings
    .map((t) => t.id)
    .sort()
    .join(".");
  return toppingKey
    ? `${productId}__${sizeId}__${toppingKey}`
    : `${productId}__${sizeId}`;
}
