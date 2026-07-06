/** Format a number as a USD price string, e.g. 12.5 → "$12.50". */
export function formatPrice(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Format a timestamp as a friendly date, e.g. "Jul 7, 2026 · 1:24 AM". */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} · ${time}`;
}

/** Pluralise a word based on a count, e.g. pluralize(2, "item") → "items". */
export function pluralize(count: number, word: string, plural?: string): string {
  if (count === 1) return word;
  return plural ?? `${word}s`;
}
