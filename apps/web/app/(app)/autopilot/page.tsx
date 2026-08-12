import { requireWorkspaceAppUser as requireCurrentAppUser } from "@/lib/workspace";
import { autopilotService } from "@narriflow/services";
import { AutopilotPanel } from "./autopilot-panel";

export default async function AutopilotPage() {
  const appUser = await requireCurrentAppUser();
  const rules = await autopilotService.listRules(appUser.id, appUser.workspaceId);

  return <AutopilotPanel initialRules={rules} />;
}
