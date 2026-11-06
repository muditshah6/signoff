import type { ReactNode } from "react";

/** Tiny markdown renderer for memos: #/## headings, - lists, **bold**, paragraphs. No HTML is ever injected. */
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|₹[\d,]+(?:\.\d+)?)/g).map((p, i) =>
    p.startsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong>
    : p.startsWith("₹") ? <span key={i} className="mono">{p}</span>
    : p);
}

export function Md({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length} className="ml-5 list-disc space-y-1">{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*[-*] /.test(line)) { list.push(line.replace(/^\s*[-*] /, "")); continue; }
    flush();
    if (!line.trim()) continue;
    const h = line.match(/^#{1,3}\s+(.*)/);
    if (h) blocks.push(<div key={blocks.length} className="eyebrow mt-1">{h[1].replace(/^\d+\.\s*/, "")}</div>);
    else blocks.push(<p key={blocks.length}>{inline(line.replace(/^\d+\.\s+/, ""))}</p>);
  }
  flush();
  return <div className="flex flex-col gap-3 leading-relaxed" style={{ color: "var(--ink-2)" }}>{blocks}</div>;
}
