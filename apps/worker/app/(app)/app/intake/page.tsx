import { NOTICE_ROLES } from "../../../../src/services/notices";
import { viewer } from "../../../_lib/server";
import { IntakeForm } from "./intake-form";

export default async function IntakePage() {
  const me = await viewer();
  return <IntakeForm canSubmit={NOTICE_ROLES.includes(me.role)} />;
}
