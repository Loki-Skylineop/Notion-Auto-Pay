import type { Metadata } from "next";
import { CheckoutClient } from "@/components/checkout/CheckoutClient";

export const metadata: Metadata = {
  title: "Checkout",
  description: "Complete your Forno order — delivery details, payment and confirmation.",
};

export default function CheckoutPage() {
  return <CheckoutClient />;
}
