import { Flame } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/** Renders 0–3 chili flames to indicate spice level. */
export function SpiceMeter({ level, className }: { level: number; className?: string }) {
  if (!level || level <= 0) return null;
  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      aria-label={`Spice level ${level} of 3`}
      title={`Spice level ${level} of 3`}
    >
      {Array.from({ length: 3 }).map((_, i) => (
        <Flame
          key={i}
          className={cn(
            "h-3.5 w-3.5",
            i < level ? "fill-ember-500 text-ember-500" : "text-charcoal-400"
          )}
          aria-hidden
        />
      ))}
    </span>
  );
}
