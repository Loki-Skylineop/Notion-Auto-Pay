"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  CreditCard,
  Wallet,
  Zap,
  CalendarClock,
} from "lucide-react";
import type { Order, PaymentMethod, DeliveryTiming } from "@/types";
import { useCartStore } from "@/lib/store/useCartStore";
import { useCartTotals } from "@/lib/hooks/useCartTotals";
import { useOrdersStore, generateOrderId } from "@/lib/store/useOrdersStore";
import { useProfileStore } from "@/lib/store/useProfileStore";
import { useUIStore } from "@/lib/store/useUIStore";
import { useHasMounted } from "@/lib/hooks/useHasMounted";
import {
  initialCheckoutValues,
  validateDelivery,
  validatePayment,
  generateTimeSlots,
  estimatedDelivery,
  formatCardNumber,
  formatExpiry,
  type CheckoutValues,
  type CheckoutErrors,
} from "@/lib/utils/checkout";
import { TextField, TextArea } from "@/components/ui/Field";
import { OrderSummary } from "@/components/cart/OrderSummary";
import { EmptyState } from "@/components/ui/EmptyState";
import { CheckoutSteps } from "./CheckoutSteps";
import { OrderReview } from "./OrderReview";
import { OrderConfirmation } from "./OrderConfirmation";
import { formatPrice } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

function OptionCard({
  active,
  onClick,
  icon: Icon,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Wallet;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex w-full items-center gap-3 rounded-2xl p-4 text-left ring-1 ring-inset transition-all",
        active
          ? "bg-flame-500/10 ring-flame-400/50"
          : "bg-white/[0.03] ring-white/10 hover:ring-white/25"
      )}
    >
      <span
        className={cn(
          "grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl transition-colors",
          active ? "bg-flame-gradient text-white" : "bg-white/5 text-charcoal-200"
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span>
        <span className="block font-semibold text-crust-50">{title}</span>
        <span className="block text-xs text-charcoal-300">{desc}</span>
      </span>
    </button>
  );
}

export function CheckoutClient() {
  const mounted = useHasMounted();
  const { lines, subtotal, deliveryFee, total } = useCartTotals();
  const clearCart = useCartStore((s) => s.clear);
  const addOrder = useOrdersStore((s) => s.addOrder);
  const savedDetails = useProfileStore((s) => s.savedDetails);
  const setDetails = useProfileStore((s) => s.setDetails);
  const addToast = useUIStore((s) => s.addToast);

  const [step, setStep] = useState(0);
  const [values, setValues] = useState<CheckoutValues>(initialCheckoutValues);
  const [errors, setErrors] = useState<CheckoutErrors>({});
  const [placedOrder, setPlacedOrder] = useState<Order | null>(null);
  const timeSlots = useMemo(() => generateTimeSlots(), []);

  // Pre-fill from a previously saved profile.
  useEffect(() => {
    if (savedDetails) {
      setValues((v) => ({
        ...v,
        name: savedDetails.name,
        phone: savedDetails.phone,
        address: savedDetails.address,
        comment: savedDetails.comment ?? "",
      }));
    }
  }, [savedDetails]);

  const setValue = <K extends keyof CheckoutValues>(key: K, val: CheckoutValues[K]) => {
    setValues((v) => ({ ...v, [key]: val }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  const goNext = () => {
    if (step === 0) {
      const e = validateDelivery(values);
      setErrors(e);
      if (Object.keys(e).length > 0) return;
    }
    if (step === 1) {
      const e = validatePayment(values);
      setErrors(e);
      if (Object.keys(e).length > 0) return;
    }
    setStep((s) => Math.min(2, s + 1));
  };

  const goBack = () => setStep((s) => Math.max(0, s - 1));

  const placeOrder = () => {
    const est = estimatedDelivery(values);
    const order: Order = {
      id: generateOrderId(),
      createdAt: Date.now(),
      items: lines,
      subtotal,
      deliveryFee,
      total,
      delivery: {
        name: values.name.trim(),
        phone: values.phone.trim(),
        address: values.address.trim(),
        comment: values.comment.trim() || undefined,
      },
      timing: values.timing,
      scheduledTime: values.timing === "scheduled" ? values.scheduledTime : undefined,
      payment: values.payment,
      status: "Preparing",
      estimatedMinutes: est.minutes,
    };

    addOrder(order);
    setDetails(order.delivery);
    clearCart();
    setPlacedOrder(order);
    addToast({
      kind: "success",
      title: "Order placed!",
      description: `${order.id} is on its way`,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Confirmation view (kept even though the cart is now empty).
  if (placedOrder) {
    return (
      <div className="container-page py-12 sm:py-16">
        <OrderConfirmation order={placedOrder} etaLabel={estimatedDelivery(values).label} />
      </div>
    );
  }

  // Empty cart guard.
  if (mounted && lines.length === 0) {
    return (
      <div className="container-page py-16">
        <EmptyState
          emoji="🛒"
          title="Your cart is empty"
          description="Add a few pizzas before heading to checkout."
          action={
            <Link href="/#menu" className="btn btn-primary px-5 py-2.5">
              Browse the menu
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="container-page py-10 sm:py-14">
      <h1 className="mb-6 font-display text-3xl font-bold text-crust-50 sm:text-4xl">Checkout</h1>

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        {/* Main */}
        <div>
          <div className="mb-8">
            <CheckoutSteps current={step} />
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.25 }}
            >
              {step === 0 && (
                <div className="space-y-5">
                  <div className="surface space-y-4 p-5">
                    <h2 className="font-display text-lg font-semibold text-crust-50">
                      Delivery details
                    </h2>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <TextField
                        label="Full name"
                        required
                        autoComplete="name"
                        placeholder="Sofia Rossi"
                        value={values.name}
                        error={errors.name}
                        onChange={(e) => setValue("name", e.target.value)}
                      />
                      <TextField
                        label="Phone"
                        required
                        type="tel"
                        autoComplete="tel"
                        placeholder="+1 415 555 0132"
                        value={values.phone}
                        error={errors.phone}
                        onChange={(e) => setValue("phone", e.target.value)}
                      />
                    </div>
                    <TextField
                      label="Delivery address"
                      required
                      autoComplete="street-address"
                      placeholder="27 Marconi Street, Apt 4B, San Francisco"
                      value={values.address}
                      error={errors.address}
                      onChange={(e) => setValue("address", e.target.value)}
                    />
                    <TextArea
                      label="Delivery notes (optional)"
                      placeholder="Ring the top bell, leave at the door…"
                      value={values.comment}
                      onChange={(e) => setValue("comment", e.target.value)}
                    />
                  </div>

                  <div className="surface space-y-4 p-5">
                    <h2 className="font-display text-lg font-semibold text-crust-50">
                      When would you like it?
                    </h2>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <OptionCard
                        active={values.timing === "asap"}
                        onClick={() => setValue("timing", "asap" as DeliveryTiming)}
                        icon={Zap}
                        title="As soon as possible"
                        desc="Delivered in ~30–40 min"
                      />
                      <OptionCard
                        active={values.timing === "scheduled"}
                        onClick={() => setValue("timing", "scheduled" as DeliveryTiming)}
                        icon={CalendarClock}
                        title="Schedule for later"
                        desc="Pick a time slot"
                      />
                    </div>
                    {values.timing === "scheduled" && (
                      <div>
                        <label htmlFor="slot" className="field-label">
                          Delivery time <span className="text-ember-400">*</span>
                        </label>
                        <select
                          id="slot"
                          value={values.scheduledTime}
                          onChange={(e) => setValue("scheduledTime", e.target.value)}
                          className={cn("field-input cursor-pointer", errors.scheduledTime && "field-input-error")}
                        >
                          <option value="" className="bg-charcoal-800">
                            Choose a time…
                          </option>
                          {timeSlots.map((slot) => (
                            <option key={slot.value} value={slot.value} className="bg-charcoal-800">
                              {slot.label}
                            </option>
                          ))}
                        </select>
                        {errors.scheduledTime && (
                          <p className="mt-1.5 text-xs text-ember-300">{errors.scheduledTime}</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {step === 1 && (
                <div className="surface space-y-4 p-5">
                  <h2 className="font-display text-lg font-semibold text-crust-50">
                    Payment method
                  </h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <OptionCard
                      active={values.payment === "cash"}
                      onClick={() => setValue("payment", "cash" as PaymentMethod)}
                      icon={Wallet}
                      title="Cash on delivery"
                      desc="Pay when it arrives"
                    />
                    <OptionCard
                      active={values.payment === "card"}
                      onClick={() => setValue("payment", "card" as PaymentMethod)}
                      icon={CreditCard}
                      title="Card"
                      desc="Pay now (demo only)"
                    />
                  </div>

                  {values.payment === "card" && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="space-y-4 pt-1"
                    >
                      <TextField
                        label="Card number"
                        required
                        inputMode="numeric"
                        placeholder="4242 4242 4242 4242"
                        value={values.cardNumber}
                        error={errors.cardNumber}
                        onChange={(e) => setValue("cardNumber", formatCardNumber(e.target.value))}
                      />
                      <div className="grid grid-cols-2 gap-4">
                        <TextField
                          label="Expiry"
                          required
                          inputMode="numeric"
                          placeholder="MM/YY"
                          value={values.cardExpiry}
                          error={errors.cardExpiry}
                          onChange={(e) => setValue("cardExpiry", formatExpiry(e.target.value))}
                        />
                        <TextField
                          label="CVC"
                          required
                          inputMode="numeric"
                          placeholder="123"
                          maxLength={4}
                          value={values.cardCvc}
                          error={errors.cardCvc}
                          onChange={(e) =>
                            setValue("cardCvc", e.target.value.replace(/\D/g, "").slice(0, 4))
                          }
                        />
                      </div>
                      <p className="rounded-xl bg-white/[0.03] p-3 text-xs text-charcoal-400">
                        This is a demo store — no real payment is processed and no card data leaves
                        your browser.
                      </p>
                    </motion.div>
                  )}
                </div>
              )}

              {step === 2 && <OrderReview values={values} />}
            </motion.div>
          </AnimatePresence>

          {/* Nav */}
          <div className="mt-6 flex items-center justify-between gap-3">
            {step > 0 ? (
              <button type="button" onClick={goBack} className="btn btn-ghost px-5 py-3">
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
            ) : (
              <Link href="/#menu" className="btn btn-ghost px-5 py-3">
                <ArrowLeft className="h-4 w-4" />
                Keep shopping
              </Link>
            )}

            {step < 2 ? (
              <button type="button" onClick={goNext} className="btn btn-primary px-6 py-3">
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button type="button" onClick={placeOrder} className="btn btn-primary px-6 py-3">
                Place order · {formatPrice(total)}
              </button>
            )}
          </div>
        </div>

        {/* Summary sidebar */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="surface p-5">
            <h2 className="mb-4 font-display text-lg font-semibold text-crust-50">Summary</h2>
            <OrderSummary />
          </div>
        </aside>
      </div>
    </div>
  );
}
