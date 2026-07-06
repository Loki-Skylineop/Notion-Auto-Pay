"use client";

import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  id?: string;
}

export function SearchBar({
  value,
  onChange,
  className,
  placeholder = "Search the menu…",
  id,
}: SearchBarProps) {
  return (
    <div className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-charcoal-400"
        aria-hidden
      />
      <input
        id={id}
        type="search"
        role="searchbox"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="Search the menu"
        className="w-full rounded-full border border-white/10 bg-charcoal-900/70 py-2.5 pl-11 pr-10 text-sm text-crust-50 placeholder:text-charcoal-400 transition-colors focus:border-flame-400/60 focus:bg-charcoal-900 focus:outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-charcoal-300 transition-colors hover:bg-white/10 hover:text-crust-50"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
