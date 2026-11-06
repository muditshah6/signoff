import {
  pgTable, text, integer, real, timestamp, jsonb, uuid, date, unique, index, boolean,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const firms = pgTable("firms", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role", { enum: ["owner", "manager", "bookkeeper", "auditor"] }).notNull().default("bookkeeper"),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
});

/** Bookkeepers only reach clients assigned to them (owners and managers reach all). */
export const clientAssignments = pgTable("client_assignments", {
  userId: uuid("user_id").notNull().references(() => users.id),
  clientId: uuid("client_id").notNull().references(() => clients.id),
}, (t) => [unique().on(t.userId, t.clientId)]);

/** Personal MCP tokens: Claude acts as the person who connected it. Auditors get none. */
export const mcpTokens = pgTable("mcp_tokens", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const clients = pgTable("clients", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  name: text("name").notNull(),
  sourceTools: text("source_tools").array().notNull().default([]),
  color: text("color").notNull().default("#4f46e5"),
  cfoEmail: text("cfo_email"),
  createdAt: createdAt(),
});

export const reviews = pgTable("reviews", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  month: text("month").notNull(), // YYYY-MM
  status: text("status", { enum: ["draft", "in_review", "shared", "closed"] }).notNull().default("draft"),
  playbookVersion: integer("playbook_version"),
  createdAt: createdAt(),
}, (t) => [unique().on(t.clientId, t.month)]);

export const transactions = pgTable("transactions", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  reviewId: uuid("review_id").notNull().references(() => reviews.id),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  extId: text("ext_id").notNull(), // e.g. VP-10014, what humans and Claude cite
  txnDate: date("txn_date").notNull(),
  merchant: text("merchant").notNull(),
  vendorKey: text("vendor_key").notNull(),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("INR"),
  category: text("category"),
  cardLast4: text("card_last4"),
  employee: text("employee"),
  department: text("department"),
  receiptStatus: text("receipt_status"),
  notes: text("notes"),
  injectionSuspected: boolean("injection_suspected").notNull().default(false),
  rawJson: jsonb("raw_json"),
}, (t) => [index("txn_review_idx").on(t.reviewId)]);

/** Every imported file, from either entry point. Proof of the source without keeping card numbers. */
export const sourceFiles = pgTable("source_files", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  reviewId: uuid("review_id").notNull().references(() => reviews.id),
  source: text("source", { enum: ["chat", "upload"] }).notNull(),
  sha256: text("sha256").notNull(), // of the exact text received
  bytes: integer("bytes").notNull(),
  rowCount: integer("row_count").notNull(),
  total: real("total").notNull(),
  rejected: jsonb("rejected").notNull().default([]), // [{ line, error }]
  maskedText: text("masked_text").notNull(), // card numbers cut to the last 4 digits
  superseded: boolean("superseded").notNull().default(false), // a re-ingest while the review was a draft
  createdBy: text("created_by"),
  createdAt: createdAt(),
});

export const findings = pgTable("findings", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  reviewId: uuid("review_id").notNull().references(() => reviews.id),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  title: text("title").notNull(),
  detail: text("detail"),
  issueType: text("issue_type").notNull(),
  vendor: text("vendor"),
  severity: text("severity", { enum: ["low", "medium", "high"] }).notNull().default("medium"),
  suggestedAction: text("suggested_action"),
  basis: text("basis", { enum: ["rule", "episode", "reference", "parametric"] }).notNull(),
  txnIds: uuid("txn_ids").array().notNull().default([]),
  memoryRefs: jsonb("memory_refs").notNull().default([]),
  confidence: real("confidence"),
  status: text("status", {
    enum: ["ai_draft", "edited", "approved", "disputed", "needs_receipt", "suppressed", "dropped"],
  }).notNull().default("ai_draft"),
  owner: text("owner"),
  authorType: text("author_type", { enum: ["claude", "user", "client"] }).notNull().default("claude"),
  suppressedBy: uuid("suppressed_by"),
  decisionReason: text("decision_reason"),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const findingVersions = pgTable("finding_versions", {
  id: id(),
  findingId: uuid("finding_id").notNull().references(() => findings.id),
  version: integer("version").notNull(),
  authorType: text("author_type", { enum: ["claude", "user", "client"] }).notNull(),
  authorId: text("author_id"),
  diffJson: jsonb("diff_json").notNull(),
  createdAt: createdAt(),
});

export const comments = pgTable("comments", {
  id: id(),
  findingId: uuid("finding_id").notNull().references(() => findings.id),
  authorType: text("author_type", { enum: ["claude", "user", "client"] }).notNull(),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const memos = pgTable("memos", {
  id: id(),
  reviewId: uuid("review_id").notNull().references(() => reviews.id),
  version: integer("version").notNull(),
  markdown: text("markdown").notNull(),
  authorType: text("author_type", { enum: ["claude", "user"] }).notNull(),
  createdAt: createdAt(),
});

export const shareLinks = pgTable("share_links", {
  id: id(),
  reviewId: uuid("review_id").notNull().references(() => reviews.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  otpEmail: text("otp_email").notNull(),
  approverName: text("approver_name"),
  createdBy: text("created_by"),
  otpHash: text("otp_hash"),
  otpExpiresAt: timestamp("otp_expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  viewLog: jsonb("view_log").notNull().default([]),
  createdAt: createdAt(),
});

export const memoryItems = pgTable("memory_items", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  type: text("type", { enum: ["semantic", "procedural"] }).notNull(),
  key: text("key").notNull(), // exact retrieval key, e.g. "vendor:taj"
  vendor: text("vendor"),
  issueType: text("issue_type"),
  content: text("content").notNull(),
  status: text("status", { enum: ["pending", "active", "under_review", "retired"] }).notNull().default("pending"),
  evidenceIds: uuid("evidence_ids").array().notNull().default([]),
  approvedBy: text("approved_by"),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo: timestamp("valid_to", { withTimezone: true }),
  hitCount: integer("hit_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  author: text("author").notNull(),
  createdAt: createdAt(),
});

export const episodes = pgTable("episodes", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  month: text("month").notNull(),
  vendor: text("vendor"),
  issueType: text("issue_type").notNull(),
  aiSaid: text("ai_said"),
  humanChange: text("human_change"),
  clientDecision: text("client_decision"),
  reason: text("reason"),
  decidedBy: text("decided_by").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  sourceFindingId: uuid("source_finding_id"),
});

export const followups = pgTable("followups", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  dueMonth: text("due_month").notNull(),
  text: text("text").notNull(),
  txnIds: text("txn_ids").array().notNull().default([]), // external ids, e.g. VP-10009
  status: text("status", { enum: ["open", "done", "escalated"] }).notNull().default("open"),
  sourceFindingId: uuid("source_finding_id"),
  cyclesOpen: integer("cycles_open").notNull().default(0),
  createdAt: createdAt(),
});

export const playbooks = pgTable("playbooks", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  clientId: uuid("client_id").references(() => clients.id),
  version: integer("version").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const references = pgTable("references", {
  id: id(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  topic: text("topic").notNull(),
  version: integer("version").notNull().default(1),
  body: text("body").notNull(),
  sourceUrl: text("source_url").notNull(),
  asOf: date("as_of").notNull(),
});

export const auditEvents = pgTable("audit_events", {
  id: id(),
  seq: integer("seq").notNull(),
  firmId: uuid("firm_id").notNull().references(() => firms.id),
  clientId: uuid("client_id"),
  actorType: text("actor_type", { enum: ["claude", "user", "client", "system"] }).notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  entity: text("entity"),
  payloadJson: jsonb("payload_json").notNull().default({}),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [unique().on(t.firmId, t.seq)]);
