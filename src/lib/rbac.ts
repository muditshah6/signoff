export type Role = "owner" | "manager" | "bookkeeper" | "auditor";

export type Ctx = {
  firmId: string;
  userId: string;
  role: Role;
  /** Who is acting. Claude acts as the person who connected it, with that person's role. */
  actor: "user" | "claude";
  name: string;
};

export type Action =
  | "client.read" | "csv.upload" | "review.run" | "finding.edit" | "review.share"
  | "memory.read" | "memory.decide" | "memory.retire" | "playbook.edit"
  | "audit.read" | "token.manage" | "client.delete";

/** Permission matrix. Bookkeepers are further limited to assigned clients (see scope.ts). */
const MATRIX: Record<Role, readonly Action[]> = {
  owner: ["client.read", "csv.upload", "review.run", "finding.edit", "review.share", "memory.read", "memory.decide", "memory.retire", "playbook.edit", "audit.read", "token.manage", "client.delete"],
  manager: ["client.read", "csv.upload", "review.run", "finding.edit", "review.share", "memory.read", "memory.decide", "memory.retire", "playbook.edit", "audit.read", "token.manage"],
  bookkeeper: ["client.read", "csv.upload", "review.run", "finding.edit", "review.share", "memory.read", "audit.read", "token.manage"],
  auditor: ["client.read", "memory.read", "audit.read"],
};

export const can = (role: Role, action: Action) => MATRIX[role].includes(action);

export const DENIED_REASON: Partial<Record<Action, string>> = {
  "memory.decide": "Only a manager can approve rules",
  "memory.retire": "Only a manager can retire rules",
  "finding.edit": "Auditors have read-only access",
  "csv.upload": "Auditors have read-only access",
  "review.share": "Auditors have read-only access",
};

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", manager: "Manager", bookkeeper: "Bookkeeper", auditor: "Auditor" };
