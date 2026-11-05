import { loadAudit } from "../../../../src/services/audit";
import { workerEnv } from "../../../_lib/server";
import { AuditTable, type Entry } from "./audit-table";

export default async function AuditPage() {
  const r = await loadAudit(await workerEnv(), { limit: 300 });
  if (!r.ok) throw new Error(r.message);
  return <AuditTable entries={r.entries as Entry[]} />;
}
