# 🍕 Forno — Wood‑fired Pizza E‑commerce

A portfolio‑quality online pizza shop built with **Next.js 14 (App Router)**, **TypeScript**, **Tailwind CSS**, **Framer Motion** and **Zustand**. Every bit of state — cart, favorites, order history and your local profile — lives in **localStorage**. There is **no backend, no database and no login required**.

> Brand: **Forno** — “Wood‑fired since day one.” Warm charcoal + ember‑red / flame‑orange / cheese‑gold palette, a bold **Fraunces** display serif paired with **Inter**.

---

## ✨ Features

### Storefront / catalog
- **23 products**: 12 unique pizzas, 6 drinks, 5 desserts — each with photo, description, tags and ingredients.
- **3 pizza sizes** (25 / 30 / 40 cm) with prices that recalculate live; drinks have volume options (0.33 / 0.5 / 1 L).
- **Category tabs** (All · Pizza · Drinks · Desserts) with an animated pill indicator, driven from the header nav too.
- **Live search** across names, descriptions, tags and ingredients.
- **Sort** (popularity, price ↑/↓, name) and **dietary filters** (Vegetarian, Vegan, Spicy, Bestseller, New).
- **Hover micro‑interactions**: card lift, image zoom, quick‑add reveal.
- **Skeleton loaders** on first load and per‑image while photos stream in.

### Product detail / quick view
- Modal with a large image, full description, **ingredient list**, animated **size selector**, **quantity stepper** and an **extra‑toppings** add‑on picker with live price.
- **Add‑to‑cart flies into the cart icon**, which bounces and updates its badge, plus a toast.

### Cart
- **Slide‑in drawer** on desktop, **bottom sheet** on mobile.
- Quantity controls, per‑line + total pricing, smooth add/remove animations.
- **Persists across refresh** (localStorage), friendly **empty state**, order summary with subtotal / delivery fee / total and a free‑delivery progress nudge.

### Checkout
- **Multi‑step** flow: Delivery → Payment → Review, with an animated stepper.
- **Inline form validation**, ASAP or **scheduled** delivery slots, **cash or card** (mock, no real processing).
- **Order review** step, then an **animated confirmation** with order number and ETA.
- Order is saved to **local order history**.

### Personal account (no registration)
- Identified purely by the browser — no login/password.
- **Order history** with live mock statuses (Preparing → On the way → Delivered) and one‑tap **reorder**.
- **Saved delivery details** that auto‑fill checkout.
- **Favorites / wishlist** with a dedicated view.
- **Reset my data** with a confirmation dialog that wipes localStorage.

### Navigation, layout & polish
- Sticky header (logo, category nav, search, favorites + cart badges, profile) and a mobile bottom tab bar.
- Smooth **page transitions**, toasts, and fully **responsive**, touch‑friendly, accessible markup (labels, focus states, focus‑trapped modals, keyboard nav, reduced‑motion support).

---

## 🧱 Tech stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 14 (App Router) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS |
| Animation | Framer Motion |
| State | Zustand + `persist` middleware (localStorage) |
| Icons | lucide-react |
| Images | `next/image` + Unsplash photography |

---

## 🚀 Getting started

```bash
npm install
npm run dev      # http://localhost:3000
```

```bash
npm run build && npm run start   # production
```

Requires Node 18.17+.

---

## 🗂️ Project structure

```
app/
  layout.tsx            # root layout, fonts, global overlays
  template.tsx          # page transition wrapper
  page.tsx              # home: hero + value props + catalog
  checkout/page.tsx
  account/page.tsx
  favorites/page.tsx
  not-found.tsx
  globals.css
components/
  layout/               # Header, Footer, MobileTabBar
  catalog/              # Hero, Catalog, ProductCard, SizeSelector, ProductModal, …
  cart/                 # CartDrawer, CartItem, OrderSummary
  checkout/             # CheckoutClient, CheckoutSteps, OrderReview, OrderConfirmation
  profile/              # ProfilePanel, OrderHistory, SavedDetails, FavoritesList, ResetData
  ui/                   # Button/field/modal/toast/skeleton/image primitives
lib/
  data/products.ts      # typed product catalog
  store/                # Zustand stores (cart, favorites, orders, profile, ui, catalog)
  hooks/                # useAddToCart, useCartTotals, useFocusTrap, useMediaQuery, …
  utils/                # pricing, formatting, constants, checkout validation
types/index.ts          # shared domain types
```

---

## 🖼️ A note on images

Product photos are loaded from **Unsplash** via `next/image` (see `images.remotePatterns` in `next.config.mjs`). If any photo ever fails to load, a polished gradient + emoji placeholder is shown automatically (`components/ui/ProductImage.tsx`). Swap any URL in `lib/data/products.ts` to use your own photography.

Fonts (Fraunces + Inter) are loaded from Google Fonts via a `<link>` in the root layout.

---

## 📝 License

MIT — sample project for demonstration purposes.
