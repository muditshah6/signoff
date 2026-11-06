/** Minimal RFC-4180 parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    // neutralise spreadsheet formula injection
    const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}

export const VOLOPAY_COLUMNS = [
  "date", "merchant", "amount", "currency", "category", "card_number", "employee", "receipt_status", "description",
] as const;
const REQUIRED = ["date", "merchant", "amount"] as const;

export type ParsedTxn = {
  txnDate: string; merchant: string; amount: number; currency: string;
  category: string | null; cardLast4: string | null; employee: string | null;
  receiptStatus: string | null; description: string | null;
};

export type CsvResult =
  | { ok: true; rows: ParsedTxn[]; warnings: string[] }
  | { ok: false; errors: string[] };

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Mask any card number down to its last 4 digits. Full PANs never reach the DB. */
export function maskCard(v: string | undefined | null): string | null {
  const digits = (v ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function parseDate(v: string): string | null {
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // DD/MM/YYYY (India)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

export function ingestVolopayCsv(text: string, month?: string): CsvResult {
  const grid = parseCsv(text);
  if (grid.length < 2) return { ok: false, errors: ["CSV has no data rows"] };
  const headers = grid[0].map(norm);
  const missing = REQUIRED.filter((c) => !headers.includes(c));
  if (missing.length) return { ok: false, errors: [`Missing required column(s): ${missing.join(", ")}`] };
  const idx = (c: string) => headers.indexOf(c);
  const errors: string[] = [];
  const warnings: string[] = [];
  const rows: ParsedTxn[] = [];
  grid.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (c: string) => (idx(c) >= 0 ? (r[idx(c)] ?? "").trim() : "");
    const date = parseDate(get("date"));
    const amount = Number(get("amount").replace(/[₹,\s]/g, ""));
    if (!date) return void errors.push(`Row ${line}: invalid date "${get("date")}"`);
    if (!get("merchant")) return void errors.push(`Row ${line}: empty merchant`);
    if (!Number.isFinite(amount)) return void errors.push(`Row ${line}: invalid amount "${get("amount")}"`);
    if (month && !date.startsWith(month)) warnings.push(`Row ${line}: date ${date} is outside ${month}`);
    rows.push({
      txnDate: date, merchant: get("merchant"), amount, currency: get("currency") || "INR",
      category: get("category") || null, cardLast4: maskCard(get("card_number") || get("card")),
      employee: get("employee") || null, receiptStatus: get("receipt_status") || null,
      description: get("description") || null,
    });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, rows, warnings };
}

/**
 * Free text from the CSV is data, never instructions. Tool responses wrap it so
 * Claude can tell it apart, and nothing in the app writes it to memory.
 */
export function untrusted(text: string | null | undefined) {
  return text == null ? null : { untrusted_text: text };
}
