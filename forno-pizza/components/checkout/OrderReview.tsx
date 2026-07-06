"use client";

import { MapPin, Phone, User, Clock, CreditCard, Wallet, MessageSquare } from "lucide-react";
import { useCartTotals } from "@/lib/hooks/useCartTotals";
import { OrderSummary } from "@/components/cart/OrderSummary";
import { formatPrice } from "@/lib/utils/format";
import { lineTotal } from "@/lib/utils/pricing";
import { estimatedDelivery, type CheckoutValues } from "@/lib/utils/checkout";

function Row({ icon: Icon, children }: { icon: typeof MapPin; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 text-sm text-crust-100">
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-flame-400" />
      <span>{children}</span>
    </div>
  );
}

export function OrderReview({ values }: { values: CheckoutValues }) {
  const { lines } = useCartTotals();
  const est = estimatedDelivery(values);

  return (
    <div className="space-y-5">
      {/* Items */}
      <div className="surface p-5">
        <h3 className="mb-3 font-display text-lg font-semibold text-crust-50">
          Your order ({lines.length})
        </h3>
        <ul className="divide-y divide-white/5">
          {lines.map((line) => (
            <li key={line.lineId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span className="grid h-6 min-w-[24px] place-items-center rounded-full bg-white/5 px-1.5 text-xs font-semibold text-flame-300">
                  {line.quantity}
                </span>
                <span className="truncate text-crust-50">
                  {line.name}
                  {line.sizeId !== "regular" && (
                    <span className="text-charcoal-400"> · {line.sizeLabel}</span>
                  )}
                </span>
              </span>
              <span className="flex-shrink-0 font-medium tabular-nums text-crust-100">
                {formatPrice(lineTotal(line))}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Delivery + payment */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="surface space-y-2.5 p-5">
          <h3 className="mb-1 font-display text-base font-semibold text-crust-50">Delivery to</h3>
          <Row icon={User}>{values.name}</Row>
          <Row icon={Phone}>{values.phone}</Row>
          <Row icon={MapPin}>{values.address}</Row>
          <Row icon={Clock}>{est.label}</Row>
          {values.comment && <Row icon={MessageSquare}>{values.comment}</Row>}
        </div>
        <div className="surface space-y-2.5 p-5">
          <h3 className="mb-1 font-display text-base font-semibold text-crust-50">Payment</h3>
          {values.payment === "card" ? (
            <Row icon={CreditCard}>
              Card ending {values.cardNumber.replace(/\s/g, "").slice(-4) || "••••"}
            </Row>
          ) : (
            <Row icon={Wallet}>Cash on delivery</Row>
          )}
        </div>
      </div>

      {/* Totals */}
      <div className="surface p-5">
        <OrderSummary showProgress={false} />
      </div>
    </div>
  );
}
