import {
  EXTRACTION_MODEL,
  computeSplit,
  decide,
  explainSplit,
  extractNotice,
  type AiRunner,
  type CatalogDrug,
  type ExtractionResult,
  type Tier,
} from "@shortstop/shared";
import PostalMime from "postal-mime";
import { auditStmt } from "./lib/audit";
import { broadcast } from "./lib/board";
import { loadSiteStock } from "./lib/db";
import { getPolicy } from "./lib/policy-store";

// Bump when the prompt changes so cached extractions are not reused.
const PROMPT_VERSION = "v2";

type MarkdownAi = { toMarkdown(files: { name: string; blob: Blob }[]): Promise<{ data?: string; format?: string }[]> };

async function pdfToText(ai: MarkdownAi, name: string, bytes: ArrayBuffer): Promise<string> {
  const [res] = await ai.toMarkdown([{ name, blob: new Blob([bytes], { type: "application/pdf" }) }]);
  return res?.format === "markdown" && res.data ? res.data : "";
}

/** Plain text for the extractor: PDFs via Workers AI toMarkdown, .eml via postal-mime (with PDF attachments). */
export async function loadNoticeText(env: Env, r2Key: string, contentType: string): Promise<string> {
  const obj = await env.FILES.get(r2Key);
  if (!obj) throw new Error(`notice file missing: ${r2Key}`);
  const name = r2Key.split("/").pop() ?? "notice";
  const ai = env.AI as unknown as MarkdownAi;

  if (contentType === "application/pdf" || name.endsWith(".pdf")) return pdfToText(ai, name, await obj.arrayBuffer());

  if (contentType === "message/rfc822" || name.endsWith(".eml")) {
    const email = await PostalMime.parse(await obj.arrayBuffer());
    const body = email.text ?? (email.html ?? "").replace(/<[^>]+>/g, " ");
    const parts = [`From: ${email.from?.address ?? ""}`, `Subject: ${email.subject ?? ""}`, body];
    for (const att of email.attachments) {
      if (att.mimeType === "application/pdf") {
        const content = typeof att.content === "string" ? new TextEncoder().encode(att.content) : att.content;
        parts.push(`Attachment ${att.filename ?? "attachment.pdf"}:`, await pdfToText(ai, att.filename ?? "a.pdf", content as ArrayBuffer));
      }
    }
    return parts.join("\n");
  }
  return obj.text();
}

export async function loadCatalog(env: Env): Promise<CatalogDrug[]> {
  const { results } = await env.DB.prepare(`SELECT id, name FROM drugs ORDER BY id`).all<CatalogDrug>();
  return results;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** AI extraction, cached in KV by content hash so re-runs and retries cost no neurons. */
export async function extractWithCache(env: Env, text: string, ai: AiRunner = env.AI as unknown as AiRunner): Promise<ExtractionResult> {
  const key = `extract:${PROMPT_VERSION}:${EXTRACTION_MODEL}:${await sha256(text)}`;
  const cached = await env.CACHE.get<ExtractionResult>(key, "json");
  if (cached) return cached;
  const result = await extractNotice(ai, text, await loadCatalog(env));
  await env.CACHE.put(key, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 30 });
  return result;
}

export async function setNoticeStatus(
  env: Env,
  noticeId: string,
  status: "processing" | "ready" | "needs_triage" | "failed",
  extra: { wholesaler?: string; noticeRef?: string | null; confidence?: number; error?: string | null } = {},
) {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE notices SET status = ?, wholesaler = COALESCE(?, wholesaler), notice_ref = COALESCE(?, notice_ref),
         confidence = COALESCE(?, confidence), error = ? WHERE id = ?`,
    ).bind(status, extra.wholesaler ?? null, extra.noticeRef ?? null, extra.confidence ?? null, extra.error ?? null, noticeId),
    auditStmt(env, {
      id: `notice:${noticeId}:${status}`,
      entity: "notice",
      entityId: noticeId,
      action: `notice.${status}`,
      actor: "pipeline",
      payload: extra,
    }),
  ]);
  await broadcast(env, { type: "notice.updated", noticeId, status });
}

export type PlannedLot = { lotId: string; drugId: string; action: string; ruleId: string | null; hardFloor: string | null; reserved: boolean };

/**
 * For each extracted lot: deterministic split, substitute check, policy + hard floors,
 * then either an autopilot reservation in LotDO or a proposal waiting for a human.
 * Lot ids derive from the notice id, so a retried step never duplicates lots.
 */
export async function planLots(env: Env, noticeId: string, extraction: Extract<ExtractionResult, { ok: true }>): Promise<PlannedLot[]> {
  const policy = await getPolicy(env);
  const windowMs = Number(env.AUTOPILOT_WINDOW_MINUTES) * 60_000;
  const planned: PlannedLot[] = [];

  for (const [i, lot] of extraction.lots.entries()) {
    const lotId = `${noticeId}-${i + 1}`;
    const drug = await env.DB.prepare(`SELECT id, drug_class, tier, unit FROM drugs WHERE id = ?`)
      .bind(lot.drugId)
      .first<{ id: string; drug_class: string; tier: Tier; unit: string }>();
    if (!drug) continue;

    const sites = await loadSiteStock(env, drug.id);
    const split = computeSplit(lot.quantity, sites);
    const substitute = split.shortfall
      ? await env.DB.prepare(`SELECT substitute_id FROM substitutes WHERE drug_id = ? ORDER BY substitute_id LIMIT 1`)
          .bind(drug.id)
          .first<{ substitute_id: string }>()
      : null;
    const needsSubstitute = substitute !== null;
    const decision = decide(policy.rules, {
      tier: drug.tier,
      drugClass: drug.drug_class,
      lotQty: lot.quantity,
      confidence: extraction.confidence,
      needsSubstitute,
    });
    const status = needsSubstitute ? "needs_pharmacist" : "open";

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO lots (id, notice_id, drug_id, quantity, remaining, eta, status, action, rule_id, policy_version,
           hard_floor, proposal_json, explanation, substitute_id, substitute_status, finalizes_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).bind(
        lotId,
        noticeId,
        drug.id,
        lot.quantity,
        lot.quantity,
        lot.eta,
        status,
        decision.action,
        decision.ruleId,
        policy.version,
        decision.hardFloor,
        JSON.stringify({ allocations: split.allocations, coverAfter: split.coverAfter }),
        explainSplit(lot.quantity, drug.unit, sites, split),
        substitute?.substitute_id ?? null,
        needsSubstitute ? "pending" : null,
        Date.now(),
      ),
      auditStmt(env, {
        id: `lot:${lotId}:planned`,
        entity: "lot",
        entityId: lotId,
        action: "lot.planned",
        actor: "pipeline",
        payload: { ...decision, policyVersion: policy.version, quantity: lot.quantity, needsSubstitute },
      }),
    ]);

    const stub = env.LOT_DO.get(env.LOT_DO.idFromName(lotId));
    await stub.init(lotId, lot.quantity);

    let reserved = false;
    if (decision.action === "auto_commit" && split.allocations.length > 0) {
      const r = await stub.reserveAuto({
        commitKey: `auto:${lotId}`,
        allocations: split.allocations,
        ruleId: decision.ruleId,
        policyVersion: policy.version,
        windowMs,
      });
      reserved = r.ok;
    }
    planned.push({ lotId, drugId: drug.id, action: decision.action, ruleId: decision.ruleId, hardFloor: decision.hardFloor, reserved });
  }
  return planned;
}
