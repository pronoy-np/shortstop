import { MAX_NOTICE_FILE_BYTES, NoticeText, type IntakeMessage, type Role } from "@shortstop/shared";
import { z } from "zod";
import { batchAudited } from "../lib/audit";
import type { User } from "../lib/auth";
import { broadcast } from "../lib/board";
import { forbidUnless, invalid, type Result } from "./result";

export const NOTICE_ROLES: readonly Role[] = ["planner", "ops_lead"];
export const MAX_UPLOAD_BYTES = MAX_NOTICE_FILE_BYTES;

const NoticeUpload = z.union([
  z.object({
    file: z
      .instanceof(File)
      .refine((f) => f.size > 0, "file is empty")
      .refine((f) => f.size <= MAX_UPLOAD_BYTES, "file larger than 5 MB"),
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
