import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

interface EmptyStateProps {
  emoji?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  emoji = "🍕",
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-3xl px-6 py-14 text-center",
        className
      )}
    >
      <div className="relative mb-5">
        <div className="absolute inset-0 -z-10 animate-pulse rounded-full bg-flame-500/20 blur-2xl" />
        <div className="grid h-24 w-24 place-items-center rounded-full bg-charcoal-850 text-5xl ring-1 ring-inset ring-white/10">
          <span aria-hidden>{emoji}</span>
        </div>
      </div>
      <h3 className="text-xl font-semibold text-crust-50">{title}</h3>
      {description && (
        <p className="mt-2 max-w-sm text-sm text-charcoal-300">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
