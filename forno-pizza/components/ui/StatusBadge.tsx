import type { OrderStatus } from "@/types";
import { cn } from "@/lib/utils/cn";

const STYLES: Record<OrderStatus, { className: string; dot: string }> = {
  Preparing: { className: "bg-gold-400/15 text-gold-300 ring-gold-400/30", dot: "bg-gold-400" },
  "On the way": { className: "bg-sky-400/15 text-sky-300 ring-sky-400/30", dot: "bg-sky-400" },
  Delivered: { className: "bg-basil-400/15 text-basil-400 ring-basil-400/30", dot: "bg-basil-400" },
  Cancelled: { className: "bg-charcoal-400/15 text-charcoal-300 ring-charcoal-400/30", dot: "bg-charcoal-400" },
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const style = STYLES[status];
  return (
    <span className={cn("chip ring-1 ring-inset", style.className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", style.dot)} aria-hidden />
      {status}
    </span>
  );
}
