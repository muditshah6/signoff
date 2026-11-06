"use client";

import { useEffect, useRef, useState } from "react";

/** Counts rows with unsaved edits inside the enclosing form: "3 unsaved changes · Save version". */
export function DirtyBar({ formId, nextVersion }: { formId: string; nextVersion: number }) {
  const [rows, setRows] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    const count = () => {
      const dirty = new Set<string>();
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-row]").forEach((el) => {
        const changed = el instanceof HTMLSelectElement
          ? Array.from(el.options).findIndex((o) => o.defaultSelected) !== el.selectedIndex && el.value !== el.dataset.initial
          : el.value !== el.defaultValue;
        if (changed) dirty.add(el.dataset.row!);
      });
      setRows(dirty.size);
    };
    form.addEventListener("input", count);
    form.addEventListener("reset", () => setTimeout(count));
    return () => form.removeEventListener("input", count);
  }, [formId]);

  return (
    <div ref={ref} className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--rule)] bg-[var(--head)] px-4 py-3">
      <div className="flex items-center gap-2 text-[13px]" aria-live="polite">
        <span className="h-2 w-2 rounded-full" style={{ background: rows ? "var(--medium)" : "var(--rule)" }} />
        {rows ? <>{rows} unsaved change{rows === 1 ? "" : "s"} · each becomes a version, an audit event and a past decision Claude can recall next month</> : "No unsaved changes"}
      </div>
      <div className="flex gap-2">
        <button type="reset" className="btn btn-sm">Discard</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={rows === 0}>Save as version {nextVersion}</button>
      </div>
    </div>
  );
}
