// ---------------------------------------------------------------------------
// Domain types for the Forno pizza shop
// ---------------------------------------------------------------------------

export type Category = "pizza" | "drinks" | "desserts";

export type Tag =
  | "Bestseller"
  | "New"
  | "Spicy"
  | "Vegetarian"
  | "Vegan"
  | "Classic"
  | "Premium"
  | "Sweet"
  | "Cold";

/** A selectable size (pizza cm) or volume (drink L) for a product. */
export interface SizeOption {
  /** Stable id, e.g. "25", "30", "40" or "0.33". */
  id: string;
  /** Display label, e.g. "25 cm" or "0.33 L". */
  label: string;
  /** Short qualifier, e.g. "Personal", "Sharing", "Can". */
  sublabel?: string;
  /** Absolute price for this size (already computed, not a delta). */
  price: number;
}

/** Optional add-on topping for pizzas. */
export interface Topping {
  id: string;
  name: string;
  price: number;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  longDescription?: string;
  image: string;
  category: Category;
  /** Ordered small → large. Pizzas always have 25 / 30 / 40 cm. */
  sizes: SizeOption[];
  tags: Tag[];
  ingredients: string[];
  /** Add-ons available for this product (pizzas). */
  toppings?: Topping[];
  /** 0–100 relative popularity, used for the "Popular" sort. */
  popularity: number;
  kcal?: number;
  /** 0–3 chili rating, used to render spice indicators. */
  spiceLevel?: number;
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export interface CartLine {
  /** Unique per product + size + selected toppings combination. */
  lineId: string;
  productId: string;
  name: string;
  image: string;
  category: Category;
  sizeId: string;
  sizeLabel: string;
  /** Size price only. */
  basePrice: number;
  /** Size price + all selected toppings. */
  unitPrice: number;
  toppings: Topping[];
  quantity: number;
}

// ---------------------------------------------------------------------------
// Checkout & Orders
// ---------------------------------------------------------------------------

export type OrderStatus = "Preparing" | "On the way" | "Delivered" | "Cancelled";
export type PaymentMethod = "cash" | "card";
export type DeliveryTiming = "asap" | "scheduled";

export interface DeliveryDetails {
  name: string;
  phone: string;
  address: string;
  comment?: string;
}

export interface Order {
  /** Human-facing order number, e.g. "FRN-4821". */
  id: string;
  createdAt: number;
  items: CartLine[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  delivery: DeliveryDetails;
  timing: DeliveryTiming;
  scheduledTime?: string;
  payment: PaymentMethod;
  status: OrderStatus;
  estimatedMinutes: number;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export type ToastKind = "success" | "info" | "error" | "favorite" | "cart";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
}

export type SortKey = "popular" | "price-asc" | "price-desc" | "name";
