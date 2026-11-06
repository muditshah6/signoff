"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, match, children }: { href: string; match?: string; children: React.ReactNode }) {
  const path = usePathname();
  const active = (match ?? href).split(",").some((m) => path === m || path.startsWith(m + "/"));
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className="rounded-md px-3 py-2 no-underline"
      style={active ? { background: "var(--accent-wash)", color: "var(--accent)", fontWeight: 600 } : { color: "var(--ink-2)" }}
    >
      {children}
    </Link>
  );
}
