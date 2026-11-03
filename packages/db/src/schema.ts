import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Hospitals in the network. acuity 1 = academic/trauma (ICU, oncology), 3 = community.
export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  region: text("region").notNull(),
  acuity: integer("acuity").notNull(),
});

// tier is the drug's clinical criticality: 1 = life-critical (hard floor), 3 = routine.
export const drugs = sqliteTable("drugs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ndc: text("ndc"),
  drugClass: text("drug_class").notNull(),
  tier: integer("tier").notNull(),
  unit: text("unit").notNull(),
});

export const substitutes = sqliteTable(
  "substitutes",
  {
    drugId: text("drug_id").notNull().references(() => drugs.id),
    substituteId: text("substitute_id").notNull().references(() => drugs.id),
    note: text("note").notNull(),
  },
  (t) => [uniqueIndex("substitutes_pair").on(t.drugId, t.substituteId)],
);

// inbound = committed allocations not yet received; counts toward cover.
export const stock = sqliteTable(
  "stock",
  {
    siteId: text("site_id").notNull().references(() => sites.id),
    drugId: text("drug_id").notNull().references(() => drugs.id),
    onHand: integer("on_hand").notNull(),
    inbound: integer("inbound").notNull().default(0),
    dailyDemand: real("daily_demand").notNull(),
  },
  (t) => [uniqueIndex("stock_site_drug").on(t.siteId, t.drugId)],
);

export const users = sqliteTable("users", {
  email: text("email").primaryKey(),
  name: text("name").notNull(),
  role: text("role", { enum: ["planner", "pharmacist", "ops_lead"] }).notNull(),
});

export const notices = sqliteTable("notices", {
  id: text("id").primaryKey(),
  r2Key: text("r2_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  status: text("status", {
    enum: ["received", "processing", "ready", "needs_triage", "failed"],
  }).notNull(),
  wholesaler: text("wholesaler"),
  noticeRef: text("notice_ref"),
  confidence: real("confidence"),
  error: text("error"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const lots = sqliteTable(
  "lots",
  {
    id: text("id").primaryKey(),
    noticeId: text("notice_id").notNull().references(() => notices.id),
    drugId: text("drug_id").notNull().references(() => drugs.id),
    quantity: integer("quantity").notNull(),
    remaining: integer("remaining").notNull(),
    eta: text("eta"),
    status: text("status", {
      enum: ["open", "needs_pharmacist", "reserved", "committed"],
    }).notNull(),
    action: text("action", { enum: ["auto_commit", "propose", "manual_only"] }).notNull(),
    ruleId: text("rule_id"),
    policyVersion: integer("policy_version"),
    hardFloor: text("hard_floor"),
    proposalJson: text("proposal_json").notNull(),
    explanation: text("explanation").notNull(),
    substituteId: text("substitute_id").references(() => drugs.id),
    substituteStatus: text("substitute_status", { enum: ["pending", "approved", "rejected"] }),
    finalizesAt: integer("finalizes_at"),
    // LotDO ledger version last projected here; mirror writes only move it forward.
    stateVersion: integer("state_version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("lots_notice").on(t.noticeId), index("lots_status").on(t.status)],
);

export const allocations = sqliteTable(
  "allocations",
  {
    id: text("id").primaryKey(),
    lotId: text("lot_id").notNull().references(() => lots.id),
    siteId: text("site_id").notNull().references(() => sites.id),
    quantity: integer("quantity").notNull(),
    kind: text("kind", { enum: ["manual", "auto"] }).notNull(),
    actor: text("actor").notNull(),
    commitKey: text("commit_key").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [
    index("allocations_lot").on(t.lotId),
    uniqueIndex("allocations_commit_site").on(t.commitKey, t.siteId),
  ],
);

export const policyVersions = sqliteTable("policy_versions", {
  version: integer("version").primaryKey(),
  rulesJson: text("rules_json").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    payloadJson: text("payload_json").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [index("audit_entity").on(t.entity, t.entityId), index("audit_at").on(t.at)],
);

export const deadLetters = sqliteTable("dead_letters", {
  id: text("id").primaryKey(),
  queue: text("queue").notNull(),
  bodyJson: text("body_json").notNull(),
  attempts: integer("attempts").notNull(),
  at: integer("at").notNull(),
});
