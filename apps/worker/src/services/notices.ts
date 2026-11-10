import {
  DISMISSABLE_NOTICE_STATUSES,
  DismissReason,
  MAX_NOTICE_FILE_BYTES,
  NOTICE_FILE_TOO_BIG,
  NoticeText,
  type IntakeMessage,
  type NoticeStatus,
  type Role,
} from "@shortstop/shared";
import { z } from "zod";
import { batchAudited } from "../lib/audit";
import type { User } from "../lib/auth";
import { broadcast } from "../lib/board";
import { fail, forbidUnless, invalid, isRecord, type Result } from "./result";

export const NOTICE_ROLES: readonly Role[] = ["planner", "ops_lead"];
export const MAX_UPLOAD_BYTES = MAX_NOTICE_FILE_BYTES;

const NoticeUpload = z.union([
  z.object({
    file: z
      .instanceof(File)
      .refine((f) => f.size > 0, "file is empty")
      .refine((f) => f.size <= MAX_UPLOAD_BYTES, NOTICE_FILE_TOO_BIG),
  }),
  z.object({ text: NoticeText }),
]);

/**
 * Stores a notice in R2, records it (audited), and queues it for extraction.
 * Input: `{ file?: File, text?: string }`. A non-empty file wins over pasted text.
 */
export async function submitNotice(env: Env, actor: User, input: unknown): Promise<Result<{ noticeId: string }>> {
  const denied = forbidUnless(actor, NOTICE_ROLES);
  if (denied) return denied;
  const raw = (input ?? {}) as { file?: unknown; text?: unknown };
  const parsed = NoticeUpload.safeParse(raw.file instanceof File && raw.file.size > 0 ? { file: raw.file } : { text: raw.text ?? "" });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Only the size limits (an oversized file, over-long text) are worth their own message.
    return invalid(parsed.error, issue && (issue.code === "too_big" || issue.code === "custom") ? issue.message : "attach a file or paste the notice text");
  }

  let body: ArrayBuffer | string;
  let filename: string;
  let contentType: string;
  if ("file" in parsed.data) {
    const f = parsed.data.file;
    body = await f.arrayBuffer();
    filename = f.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "notice";
    contentType = f.type || (filename.endsWith(".pdf") ? "application/pdf" : filename.endsWith(".eml") ? "message/rfc822" : "text/plain");
  } else {
    body = parsed.data.text;
    filename = "pasted.txt";
    contentType = "text/plain";
  }

  const noticeId = `n_${crypto.randomUUID().slice(0, 8)}`;
  const r2Key = `notices/${noticeId}/${filename}`;
  await env.FILES.put(r2Key, body, { httpMetadata: { contentType } });
  await batchAudited(
    env,
    [
      env.DB.prepare(
        `INSERT INTO notices (id, r2_key, filename, content_type, status, created_by, created_at) VALUES (?, ?, ?, ?, 'received', ?, ?)`,
      ).bind(noticeId, r2Key, filename, contentType, actor.email, Date.now()),
    ],
    [{ id: `notice:${noticeId}:received`, entity: "notice", entityId: noticeId, action: "notice.received", actor: actor.email, payload: { filename, contentType } }],
  );
  const msg: IntakeMessage = { noticeId, r2Key, contentType };
  await env.INTAKE_Q.send(msg);
  await broadcast(env, { type: "notice.updated", noticeId, status: "received" });
  return { ok: true, noticeId };
}

// Notice ids are `n_<id>` (see submitNotice); anything else is not a notice.
export const NoticeId = z.string().regex(/^n_[a-z0-9]{1,32}$/);
const DismissBody = z.object({ reason: DismissReason });
const DISMISSABLE: readonly NoticeStatus[] = DISMISSABLE_NOTICE_STATUSES;

/**
 * Sets a notice that needs a person (needs_triage or failed) aside as `dismissed`, with the reason, who and when
 * (planner or ops lead). Input: `{ noticeId, reason }`. Dismissing an already dismissed notice is a replay; any other
 * status is `conflict`. Dismissed notices leave the board and the needs-me count.
 */
export async function dismissNotice(env: Env, actor: User, input: unknown): Promise<Result<{ noticeId: string; replay: boolean }>> {
  const { noticeId, ...rest } = isRecord(input) ? input : {};
  const id = NoticeId.safeParse(noticeId);
  if (!id.success) return fail("not_found", "notice not found");
  const denied = forbidUnless(actor, NOTICE_ROLES);
  if (denied) return denied;
  const body = DismissBody.safeParse(rest);
  if (!body.success) return invalid(body.error);

  const status = async () =>
    (await env.DB.prepare(`SELECT status FROM notices WHERE id = ?`).bind(id.data).first<{ status: NoticeStatus }>())?.status ?? null;
  const refuse = (s: NoticeStatus | null) =>
    s === null
      ? fail("not_found", "notice not found")
      : s === "dismissed"
        ? ({ ok: true, noticeId: id.data, replay: true } as const)
        : fail("conflict", `only notices that need triage or failed can be dismissed (this one is ${s})`);

  const before = await status();
  if (before === null || !DISMISSABLE.includes(before)) return refuse(before);

  const marks = DISMISSABLE.map(() => "?").join(", ");
  const res = await batchAudited(
    env,
    [
      env.DB.prepare(
        `UPDATE notices SET status = 'dismissed', dismissed_reason = ?, dismissed_by = ?, dismissed_at = ? WHERE id = ? AND status IN (${marks})`,
      ).bind(body.data.reason, actor.email, Date.now(), id.data, ...DISMISSABLE),
    ],
    [
      {
        id: `notice:${id.data}:dismissed`,
        entity: "notice",
        entityId: id.data,
        action: "notice.dismissed",
        actor: actor.email,
        payload: { reason: body.data.reason, from: before },
        onlyIf: { sql: `SELECT 1 FROM notices WHERE id = ? AND status = 'dismissed'`, binds: [id.data] },
      },
    ],
  );
  // Lost a race with another dismiss (a replay) or a status change: answer from what is there now.
  if (!res[0]?.meta.changes) return refuse(await status());
  await broadcast(env, { type: "notice.updated", noticeId: id.data, status: "dismissed" });
  return { ok: true, noticeId: id.data, replay: false };
}
