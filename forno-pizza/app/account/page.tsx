import type { Metadata } from "next";
import { ProfilePanel } from "@/components/profile/ProfilePanel";

export const metadata: Metadata = {
  title: "Your profile",
  description: "Order history, saved delivery details and favorites — stored locally on your device.",
};

export default function AccountPage() {
  return <ProfilePanel />;
}
