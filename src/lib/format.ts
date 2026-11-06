export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export const monthName = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1];

export function ago(d: Date | null | undefined, now = Date.now()) {
  if (!d) return "never";
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const stamp = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
export const initials = (n: string) => n.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

/** A date n days before now. Kept out of components so rendering stays pure. */
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Vendors are stored in a normalised lowercase form for matching; show them as names. */
export const titleCase = (s: string | null | undefined) => (s ?? "").replace(/\b\w/g, (c) => c.toUpperCase());
