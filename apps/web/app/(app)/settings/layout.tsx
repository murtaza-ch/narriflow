import { admitWorkspacePage } from "@/lib/authenticated-request-page";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await admitWorkspacePage("content.view");
  return children;
}
