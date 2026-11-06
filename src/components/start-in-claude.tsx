"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";

/** The main path: attach the export in Claude and send this prompt. Claude passes the file to Signoff untouched. */
export function StartInClaude({ clients, defaultMonth }: { clients: { id: string; name: string }[]; defaultMonth: string }) {
  const [client, setClient] = useState(clients[0]?.name ?? "your client");
  const [month, setMonth] = useState(defaultMonth);
  const prompt = `Use the monthly_review prompt for ${client}, ${month}`;
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <select value={client} onChange={(e) => setClient(e.target.value)} className="input" aria-label="Client">
          {clients.map((c) => <option key={c.id}>{c.name}</option>)}
        </select>
        <input value={month} onChange={(e) => setMonth(e.target.value)} className="input mono w-[110px]" aria-label="Month YYYY-MM" pattern="\d{4}-\d{2}" />
      </div>
      <div className="flex items-stretch gap-2">
        <div className="mono flex-1 rounded-md bg-[var(--head)] p-2.5 text-[13px] leading-snug" style={{ border: "1px solid var(--rule)" }}>{prompt}</div>
        <CopyButton text={prompt} />
      </div>
    </div>
  );
}
