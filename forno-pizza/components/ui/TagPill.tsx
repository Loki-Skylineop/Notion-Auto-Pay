import {
  Award,
  Flame,
  Leaf,
  Snowflake,
  Sparkles,
  Sprout,
  Star,
  Cookie,
  type LucideIcon,
} from "lucide-react";
import type { Tag } from "@/types";
import { cn } from "@/lib/utils/cn";

const TAG_STYLES: Record<Tag, { className: string; icon: LucideIcon }> = {
  Bestseller: { className: "bg-gold-400/15 text-gold-300 ring-gold-400/30", icon: Star },
  New: { className: "bg-flame-500/15 text-flame-300 ring-flame-400/30", icon: Sparkles },
  Spicy: { className: "bg-ember-500/15 text-ember-300 ring-ember-400/30", icon: Flame },
  Vegetarian: { className: "bg-basil-400/15 text-basil-400 ring-basil-400/30", icon: Leaf },
  Vegan: { className: "bg-basil-500/15 text-basil-400 ring-basil-500/30", icon: Sprout },
  Classic: { className: "bg-crust-200/10 text-crust-200 ring-crust-200/20", icon: Award },
  Premium: { className: "bg-gold-500/15 text-gold-300 ring-gold-500/30", icon: Award },
  Sweet: { className: "bg-flame-400/15 text-flame-200 ring-flame-300/30", icon: Cookie },
  Cold: { className: "bg-sky-400/10 text-sky-300 ring-sky-400/30", icon: Snowflake },
};

export function TagPill({ tag, className }: { tag: Tag; className?: string }) {
  const style = TAG_STYLES[tag];
  const Icon = style.icon;
  return (
    <span className={cn("chip ring-1 ring-inset backdrop-blur-sm", style.className, className)}>
      <Icon className="h-3 w-3" aria-hidden />
      {tag}
    </span>
  );
}
