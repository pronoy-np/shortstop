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

// What the AI must return for one allocation notice. Anything that fails this goes to needs_triage.
export const ExtractedLot = z.object({
  drugName: z.string().min(1),
  ndc: z.string().optional(),
  quantity: z.number().int().positive(),
  unit: z.string().min(1),
  eta: z.iso.date().optional(),
});

export const ExtractedNotice = z.object({
  wholesaler: z.string().min(1),
  noticeRef: z.string().optional(),
  lots: z.array(ExtractedLot).min(1),
  confidence: z.number().min(0).max(1),
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
  id: z.string().min(1),
  when: z.object({
    tier: Tier.optional(),
    drugClass: z.string().optional(),
    maxLotQty: z.number().int().positive().optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    needsSubstitute: z.boolean().optional(),
  }),
  then: PolicyAction,
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const BoardEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notice.ingested"), noticeId: z.string() }),
  z.object({ type: z.literal("lot.reserved"), lotId: z.string(), finalizesAt: z.number() }),
  z.object({ type: z.literal("lot.committed"), lotId: z.string(), remaining: z.number() }),
  z.object({ type: z.literal("lot.rebased"), lotId: z.string(), remaining: z.number() }),
  z.object({ type: z.literal("lot.cancelled"), lotId: z.string() }),
]);
export type BoardEvent = z.infer<typeof BoardEvent>;
