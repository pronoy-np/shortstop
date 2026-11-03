import type { Allocation } from "@shortstop/shared";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const confirmationKey = (lotId: string, commitKey: string) =>
  `confirmations/${lotId}/${commitKey.replace(/[^a-zA-Z0-9:_-]/g, "_")}.html`;

/** Static HTML confirmation stored in R2. Cheap to render, so it stays inside the free CPU budget. */
export async function writeConfirmation(
  env: Env,
  args: { lotId: string; commitKey: string; actor: string; kind: "manual" | "auto"; allocations: Allocation[] },
): Promise<string> {
  const lot = await env.DB.prepare(
    `SELECT l.id, l.quantity, l.eta, d.name AS drug, d.unit, n.wholesaler, n.notice_ref
       FROM lots l JOIN drugs d ON d.id = l.drug_id JOIN notices n ON n.id = l.notice_id WHERE l.id = ?`,
  )
    .bind(args.lotId)
    .first<{ quantity: number; eta: string | null; drug: string; unit: string; wholesaler: string | null; notice_ref: string | null }>();
  const { results: sites } = await env.DB.prepare(`SELECT id, name FROM sites`).all<{ id: string; name: string }>();
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const total = args.allocations.reduce((s, a) => s + a.quantity, 0);
  const rows = args.allocations
    .map((a) => `<tr><td>${esc(siteName.get(a.siteId) ?? a.siteId)}</td><td>${a.quantity}</td></tr>`)
    .join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Allocation confirmation ${esc(args.lotId)}</title>
<style>body{font:14px system-ui;margin:2rem;color:#111}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px;text-align:left}</style></head><body>
<h1>Allocation confirmation</h1>
<p><b>${esc(lot?.drug ?? "")}</b> from ${esc(lot?.wholesaler ?? "unknown wholesaler")} ${lot?.notice_ref ? `(ref ${esc(lot.notice_ref)})` : ""}</p>
<p>Lot ${esc(args.lotId)} · ETA ${esc(lot?.eta ?? "not stated")} · ${total} of ${lot?.quantity ?? "?"} ${esc(lot?.unit ?? "unit")}s in this commit</p>
<p>Committed by ${esc(args.actor)} (${args.kind}) at ${new Date().toISOString()}</p>
<table><thead><tr><th>Site</th><th>Quantity</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;

  const key = confirmationKey(args.lotId, args.commitKey);
  await env.FILES.put(key, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  return key;
}
