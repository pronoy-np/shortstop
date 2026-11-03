import type { Allocation } from "@shortstop/shared";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const csvCell = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`;

const keyBase = (lotId: string, commitKey: string) => `confirmations/${lotId}/${commitKey.replace(/[^a-zA-Z0-9:_-]/g, "_")}`;
export const confirmationKey = (lotId: string, commitKey: string) => `${keyBase(lotId, commitKey)}.html`;

export type Confirmation = {
  lotId: string;
  commitKey: string;
  actor: string;
  kind: "manual" | "auto";
  allocations: Allocation[];
  at: number;
};

/**
 * HTML + CSV confirmation in R2. Cheap to render (inside the free CPU budget) and a pure
 * function of the commit, so a replayed projection writes byte-identical files.
 */
export async function writeConfirmation(env: Env, c: Confirmation): Promise<string[]> {
  const lot = await env.DB.prepare(
    `SELECT l.quantity, l.eta, d.name AS drug, d.unit, n.wholesaler, n.notice_ref
       FROM lots l JOIN drugs d ON d.id = l.drug_id JOIN notices n ON n.id = l.notice_id WHERE l.id = ?`,
  )
    .bind(c.lotId)
    .first<{ quantity: number; eta: string | null; drug: string; unit: string; wholesaler: string | null; notice_ref: string | null }>();
  const { results: sites } = await env.DB.prepare(`SELECT id, name FROM sites`).all<{ id: string; name: string }>();
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const total = c.allocations.reduce((s, a) => s + a.quantity, 0);
  const when = new Date(c.at).toISOString();

  const rows = c.allocations
    .map((a) => `<tr><td>${esc(siteName.get(a.siteId) ?? a.siteId)}</td><td>${a.quantity}</td></tr>`)
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Allocation confirmation ${esc(c.lotId)}</title>
<style>body{font:14px system-ui;margin:2rem;color:#111}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px;text-align:left}</style></head><body>
<h1>Allocation confirmation</h1>
<p><b>${esc(lot?.drug ?? "")}</b> from ${esc(lot?.wholesaler ?? "unknown wholesaler")} ${lot?.notice_ref ? `(ref ${esc(lot.notice_ref)})` : ""}</p>
<p>Lot ${esc(c.lotId)} · ETA ${esc(lot?.eta ?? "not stated")} · ${total} of ${lot?.quantity ?? "?"} ${esc(lot?.unit ?? "unit")}s in this commit</p>
<p>Committed by ${esc(c.actor)} (${c.kind}) at ${when}</p>
<table><thead><tr><th>Site</th><th>Quantity</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;

  const csv = [
    "lot_id,drug,site_id,site,quantity,kind,actor,committed_at",
    ...c.allocations.map((a) =>
      [c.lotId, lot?.drug ?? "", a.siteId, siteName.get(a.siteId) ?? a.siteId, a.quantity, c.kind, c.actor, when].map(csvCell).join(","),
    ),
  ].join("\n");

  const base = keyBase(c.lotId, c.commitKey);
  await Promise.all([
    env.FILES.put(`${base}.html`, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } }),
    env.FILES.put(`${base}.csv`, csv, { httpMetadata: { contentType: "text/csv; charset=utf-8" } }),
  ]);
  return [`${base}.html`, `${base}.csv`];
}
