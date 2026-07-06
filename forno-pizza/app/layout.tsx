import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { MobileTabBar } from "@/components/layout/MobileTabBar";
import { CartDrawer } from "@/components/cart/CartDrawer";
import { ProductModal } from "@/components/catalog/ProductModal";
import { Toaster } from "@/components/ui/Toaster";
import { FlyToCartLayer } from "@/components/ui/FlyToCartLayer";
import { BRAND } from "@/lib/utils/constants";

export const metadata: Metadata = {
  title: {
    default: `${BRAND.name} — Wood-fired pizza, delivered hot`,
    template: `%s · ${BRAND.name}`,
  },
  description:
    "Order handmade Neapolitan pizza, drinks and desserts from Forno. Slow-fermented dough, San Marzano tomatoes, wood-fired and delivered in ~30 minutes.",
  keywords: ["pizza", "delivery", "Neapolitan", "wood-fired", "Forno", "Italian food"],
  authors: [{ name: BRAND.name }],
  openGraph: {
    title: `${BRAND.name} — Wood-fired pizza, delivered hot`,
    description: "Handmade Neapolitan pizza, drinks and desserts delivered hot to your door.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#120f0b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen">
        <Header />
        <main className="min-h-[60vh]">{children}</main>
        <Footer />
        {/* Spacer so the fixed mobile tab bar never covers footer content */}
        <div className="h-16 md:hidden" aria-hidden />

        {/* Global overlays */}
        <MobileTabBar />
        <CartDrawer />
        <ProductModal />
        <Toaster />
        <FlyToCartLayer />
      </body>
    </html>
  );
}
