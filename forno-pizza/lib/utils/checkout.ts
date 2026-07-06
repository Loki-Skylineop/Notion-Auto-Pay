import type { DeliveryTiming, PaymentMethod } from "@/types";

export interface CheckoutValues {
  name: string;
  phone: string;
  address: string;
  comment: string;
  timing: DeliveryTiming;
  scheduledTime: string;
  payment: PaymentMethod;
  cardNumber: string;
  cardExpiry: string;
  cardCvc: string;
}

export type CheckoutErrors = Partial<Record<keyof CheckoutValues, string>>;

export const initialCheckoutValues: CheckoutValues = {
  name: "",
  phone: "",
  address: "",
  comment: "",
  timing: "asap",
  scheduledTime: "",
  payment: "cash",
  cardNumber: "",
  cardExpiry: "",
  cardCvc: "",
};

const digitsOnly = (s: string) => s.replace(/\D/g, "");

/** Validate the delivery step. */
export function validateDelivery(v: CheckoutValues): CheckoutErrors {
  const errors: CheckoutErrors = {};
  if (v.name.trim().length < 2) errors.name = "Please enter your full name.";
  if (digitsOnly(v.phone).length < 7) errors.phone = "Enter a valid phone number.";
  if (v.address.trim().length < 6) errors.address = "Enter a complete delivery address.";
  if (v.timing === "scheduled" && !v.scheduledTime)
    errors.scheduledTime = "Choose a delivery time.";
  return errors;
}

/** Validate the payment step. */
export function validatePayment(v: CheckoutValues): CheckoutErrors {
  const errors: CheckoutErrors = {};
  if (v.payment === "card") {
    if (digitsOnly(v.cardNumber).length !== 16)
      errors.cardNumber = "Card number must be 16 digits.";
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(v.cardExpiry.trim()))
      errors.cardExpiry = "Use MM/YY format.";
    if (!/^\d{3,4}$/.test(v.cardCvc.trim())) errors.cardCvc = "3–4 digits.";
  }
  return errors;
}

/** Format a card number into groups of 4 as the user types. */
export function formatCardNumber(value: string): string {
  return digitsOnly(value).slice(0, 16).replace(/(\d{4})(?=\d)/g, "$1 ");
}

/** Format an expiry field into MM/YY as the user types. */
export function formatExpiry(value: string): string {
  const d = digitsOnly(value).slice(0, 4);
  if (d.length <= 2) return d;
  return `${d.slice(0, 2)}/${d.slice(2)}`;
}

/** Generate upcoming 30-minute delivery slots for today. */
export function generateTimeSlots(count = 8): { value: string; label: string }[] {
  const slots: { value: string; label: string }[] = [];
  const now = new Date();
  // Round up to the next 30-minute boundary, then push one slot for prep.
  const start = new Date(now);
  start.setMinutes(now.getMinutes() > 30 ? 60 : 30, 0, 0);
  start.setMinutes(start.getMinutes() + 30);

  for (let i = 0; i < count; i++) {
    const t = new Date(start.getTime() + i * 30 * 60000);
    const label = t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    slots.push({ value: t.toISOString(), label });
  }
  return slots;
}

/** Estimated delivery description for the confirmation screen. */
export function estimatedDelivery(v: CheckoutValues): { minutes: number; label: string } {
  if (v.timing === "scheduled" && v.scheduledTime) {
    const t = new Date(v.scheduledTime);
    return {
      minutes: 40,
      label: `Scheduled for ${t.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })}`,
    };
  }
  return { minutes: 35, label: "in about 30–40 minutes" };
}
