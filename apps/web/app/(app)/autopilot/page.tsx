import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { autopilotService } from "@narriflow/services";
import { AutopilotPanel } from "./autopilot-panel";

export default async function AutopilotPage() {
  const appUser = await admitWorkspacePage("content.view");
  const rules = await autopilotService.listRules(appUser);

  return <AutopilotPanel initialRules={rules} />;
}
