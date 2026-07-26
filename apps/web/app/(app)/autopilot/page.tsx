import { requireCurrentAppUser } from "@narriflow/auth";
import { autopilotService } from "@narriflow/services";
import { AutopilotPanel } from "./autopilot-panel";

export default async function AutopilotPage() {
  const appUser = await requireCurrentAppUser();
  const rules = await autopilotService.listRules(appUser.id);

  return <AutopilotPanel initialRules={rules} />;
}
