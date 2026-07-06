"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DeliveryDetails } from "@/types";

interface ProfileState {
  savedDetails: DeliveryDetails | null;
  /** Optional friendly display name for the local "profile". */
  displayName: string;
  setDetails: (details: DeliveryDetails) => void;
  setDisplayName: (name: string) => void;
  clear: () => void;
}

export const useProfileStore = create<ProfileState>()(
  persist(
    (set) => ({
      savedDetails: null,
      displayName: "",
      setDetails: (details) =>
        set({
          savedDetails: details,
          displayName: details.name || "",
        }),
      setDisplayName: (name) => set({ displayName: name }),
      clear: () => set({ savedDetails: null, displayName: "" }),
    }),
    { name: "forno-profile" }
  )
);
