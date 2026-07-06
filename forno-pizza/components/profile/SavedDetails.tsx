"use client";

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { useProfileStore } from "@/lib/store/useProfileStore";
import { useUIStore } from "@/lib/store/useUIStore";
import { useHasMounted } from "@/lib/hooks/useHasMounted";
import { TextField, TextArea } from "@/components/ui/Field";
import type { DeliveryDetails } from "@/types";

const empty: DeliveryDetails = { name: "", phone: "", address: "", comment: "" };

export function SavedDetails() {
  const mounted = useHasMounted();
  const savedDetails = useProfileStore((s) => s.savedDetails);
  const setDetails = useProfileStore((s) => s.setDetails);
  const addToast = useUIStore((s) => s.addToast);

  const [form, setForm] = useState<DeliveryDetails>(empty);
  const [errors, setErrors] = useState<{ name?: string; phone?: string; address?: string }>({});

  useEffect(() => {
    setForm(savedDetails ? { comment: "", ...savedDetails } : empty);
  }, [savedDetails]);

  const update = (key: keyof DeliveryDetails, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const handleSave = () => {
    const e: typeof errors = {};
    if (form.name.trim().length < 2) e.name = "Enter your name.";
    if (form.phone.replace(/\D/g, "").length < 7) e.phone = "Enter a valid phone.";
    if (form.address.trim().length < 6) e.address = "Enter a full address.";
    setErrors(e);
    if (Object.keys(e).length > 0) return;

    setDetails({
      name: form.name.trim(),
      phone: form.phone.trim(),
      address: form.address.trim(),
      comment: form.comment?.trim() || undefined,
    });
    addToast({ kind: "success", title: "Details saved", description: "They'll auto-fill at checkout." });
  };

  if (!mounted) {
    return <div className="h-64 animate-pulse rounded-3xl bg-white/5" aria-hidden />;
  }

  return (
    <div className="surface space-y-4 p-5 sm:p-6">
      <div>
        <h2 className="font-display text-lg font-semibold text-crust-50">Delivery details</h2>
        <p className="mt-1 text-sm text-charcoal-300">
          Saved locally in your browser and used to auto-fill checkout.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Full name"
          value={form.name}
          error={errors.name}
          autoComplete="name"
          onChange={(e) => update("name", e.target.value)}
        />
        <TextField
          label="Phone"
          type="tel"
          value={form.phone}
          error={errors.phone}
          autoComplete="tel"
          onChange={(e) => update("phone", e.target.value)}
        />
      </div>
      <TextField
        label="Delivery address"
        value={form.address}
        error={errors.address}
        autoComplete="street-address"
        onChange={(e) => update("address", e.target.value)}
      />
      <TextArea
        label="Default delivery notes (optional)"
        value={form.comment ?? ""}
        onChange={(e) => update("comment", e.target.value)}
      />

      <div className="flex justify-end">
        <button type="button" onClick={handleSave} className="btn btn-primary px-5 py-2.5">
          <Save className="h-4 w-4" />
          Save details
        </button>
      </div>
    </div>
  );
}
