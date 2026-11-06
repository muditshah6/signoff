import { toCsv } from "@/lib/csv";
import { listAudit } from "@/lib/audit";
import { can } from "@/lib/rbac";
import { ForbiddenError } from "@/lib/scope";
import { getSession } from "@/lib/session";
import { loadReview } from "@/lib/views";

/** CSV exports: `kind=resolved&review=<id>` (resolved findings) or `kind=audit` (the whole chain). */
export async function GET(req: Request) {
  const s = await getSession();
  if (!s) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const file = (name: string, csv: string) =>
    new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` } });

  if (kind === "audit") {
    if (!can(s.ctx.role, "audit.read")) return new Response("Forbidden", { status: 403 });
    const rows = (await listAudit(s.db, s.ctx.firmId)).reverse();
    return file("audit-trail.csv", toCsv([
      ["seq", "created_at", "actor_type", "actor", "action", "entity", "payload", "prev_hash", "hash"],
      ...rows.map((r) => [r.seq, r.createdAt.toISOString(), r.actorType, r.actorId, r.action, r.entity, JSON.stringify(r.payloadJson), r.prevHash, r.hash]),
    ]));
  }
  if (kind === "resolved") {
    try {
      const d = await loadReview(s.db, s.ctx, url.searchParams.get("review") ?? "");
      const rows = d.findings.filter((f) => ["approved", "disputed", "needs_receipt"].includes(f.status))
        .map((f) => [f.txns.map((t) => t.extId).join(" "), f.title, f.issueType, f.severity, f.status, f.decisionReason, f.decidedBy, f.decidedAt?.toISOString(), f.owner, f.amount]);
      return file(`resolved-${d.client.name.replace(/\W+/g, "-")}-${d.review.month}.csv`, toCsv([
        ["transactions", "title", "issue_type", "severity", "status", "reason", "decided_by", "decided_at", "owner", "amount"], ...rows,
      ]));
    } catch (e) {
      if (e instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
      throw e;
    }
  }
  return new Response("Unknown export", { status: 400 });
}
