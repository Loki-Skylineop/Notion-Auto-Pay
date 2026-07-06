"use client";

import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { resetAllData } from "@/lib/store/resetData";
import { useUIStore } from "@/lib/store/useUIStore";
import { Modal } from "@/components/ui/Modal";

export function ResetData() {
  const [open, setOpen] = useState(false);
  const addToast = useUIStore((s) => s.addToast);

  const handleReset = () => {
    resetAllData();
    setOpen(false);
    addToast({
      kind: "success",
      title: "All data cleared",
      description: "Cart, favorites, orders and profile were reset.",
    });
  };

  return (
    <div className="rounded-3xl border border-ember-500/20 bg-ember-500/[0.04] p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-ember-500/15 text-ember-300">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div>
            <h2 className="font-display text-lg font-semibold text-crust-50">Reset my data</h2>
            <p className="mt-0.5 text-sm text-charcoal-300">
              Permanently clears your cart, favorites, order history and saved details from this
              browser.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn flex-shrink-0 bg-ember-500/15 px-5 py-2.5 text-ember-200 ring-1 ring-inset ring-ember-500/30 hover:bg-ember-500/25"
        >
          <Trash2 className="h-4 w-4" />
          Reset data
        </button>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} labelledBy="reset-title" className="sm:!max-w-md">
        <div className="p-6 text-center">
          <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-ember-500/15 text-ember-300">
            <AlertTriangle className="h-7 w-7" />
          </span>
          <h2 id="reset-title" className="font-display text-xl font-bold text-crust-50">
            Reset everything?
          </h2>
          <p className="mt-2 text-sm text-charcoal-300">
            This can&apos;t be undone. Your cart, favorites, order history and saved delivery
            details will be permanently removed from this browser.
          </p>
          <div className="mt-6 flex gap-3">
            <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost flex-1 py-3">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="btn flex-1 bg-ember-600 py-3 text-white hover:bg-ember-500"
            >
              Yes, reset
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
