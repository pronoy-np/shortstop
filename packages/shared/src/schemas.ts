import { z } from "zod";

export const Tier = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Tier = z.infer<typeof Tier>;

export const Role = z.enum(["planner", "pharmacist", "ops_lead"]);
export type Role = z.infer<typeof Role>;

// Message on the intake queue: points at a notice already stored in R2.
export const IntakeMessage = z.object({
  noticeId: z.string().min(1),
  r2Key: z.string().min(1),
  contentType: z.string(),
});
export type IntakeMessage = z.infer<typeof IntakeMessage>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// What the AI must return for one allocation notice. Anything that fails this goes to needs_triage.
export const ExtractedLot = z.object({
  drugName: z.string().min(1),
  drugId: z.string().nullish(),
  // 0 is legal (a cancelled line); validateExtraction drops it with a warning.
  quantity: z.coerce.number().int().nonnegative(),
  unit: z.string().min(1),
  eta: z.union([isoDate, z.literal(""), z.null()]).optional(),
});
export type ExtractedLot = z.infer<typeof ExtractedLot>;

export const ExtractedNotice = z.object({
  isAllocationNotice: z.boolean(),
  wholesaler: z.string().min(1),
  noticeRef: z.string().nullish(),
  lots: z.array(ExtractedLot),
  confidence: z.coerce.number().min(0).max(1),
});
export type ExtractedNotice = z.infer<typeof ExtractedNotice>;

export const Allocation = z.object({
  siteId: z.string().min(1),
  quantity: z.number().int().nonnegative(),
});
export type Allocation = z.infer<typeof Allocation>;

export const PolicyAction = z.enum(["auto_commit", "propose", "manual_only"]);
export type PolicyAction = z.infer<typeof PolicyAction>;

export const PolicyRule = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  when: z
    .object({
      tier: Tier.optional(),
      drugClass: z.string().min(1).optional(),
      maxLotQty: z.number().int().positive().optional(),
      minConfidence: z.number().min(0).max(1).optional(),
      needsSubstitute: z.boolean().optional(),
    })
    .strict(),
  then: PolicyAction,
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const PolicyRules = z
  .array(PolicyRule)
  .max(50)
  .refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length, "rule ids must be unique");

/** Largest notice file the desk accepts (the Worker enforces it; the intake form checks it before uploading). */
export const MAX_NOTICE_FILE_BYTES = 5 * 1024 * 1024;
export const NOTICE_FILE_TOO_BIG = "file larger than 5 MB";

/** Pasted notice text: validated in the browser and again on the server with this same schema. */
export const NoticeText = z.string().trim().min(1, "paste the notice text").max(100_000, "text too long (max 100,000 characters)");

export const CommitRequest = z.object({
  allocations: z.array(Allocation).min(1).max(50),
  // Optional in the body when the request carries an Idempotency-Key header instead.
  commitKey: z.string().min(8).max(100).optional(),
});
export type CommitRequest = z.infer<typeof CommitRequest>;

// dismissed: a person looked at a needs_triage or failed notice and set it aside (with a reason). Terminal.
export const NoticeStatus = z.enum(["received", "processing", "ready", "needs_triage", "failed", "dismissed"]);
export type NoticeStatus = z.infer<typeof NoticeStatus>;

export const LotStatus = z.enum(["open", "needs_pharmacist", "reserved", "committed"]);
export type LotStatus = z.infer<typeof LotStatus>;

export const SubstituteDecision = z.enum(["approved", "rejected"]);
export type SubstituteDecision = z.infer<typeof SubstituteDecision>;

export const BoardEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notice.updated"), noticeId: z.string(), status: NoticeStatus }),
  z.object({ type: z.literal("notice.ingested"), noticeId: z.string(), lots: z.number() }),
  z.object({ type: z.literal("notice.enriched"), noticeId: z.string(), precedents: z.number() }),
  z.object({ type: z.literal("lot.reserved"), lotId: z.string(), finalizesAt: z.number() }),
  z.object({ type: z.literal("lot.committed"), lotId: z.string(), remaining: z.number(), actor: z.string() }),
  z.object({ type: z.literal("lot.rebased"), lotId: z.string(), remaining: z.number(), actor: z.string() }),
  z.object({ type: z.literal("lot.cancelled"), lotId: z.string(), actor: z.string() }),
  z.object({ type: z.literal("lot.substitute"), lotId: z.string(), status: SubstituteDecision }),
  z.object({ type: z.literal("policy.saved"), version: z.number() }),
  z.object({ type: z.literal("policy.reapplied"), version: z.number(), toAutopilot: z.number(), toPlanner: z.number() }),
  z.object({ type: z.literal("stock.reset"), actor: z.string() }),
]);
export type BoardEvent = z.infer<typeof BoardEvent>;
