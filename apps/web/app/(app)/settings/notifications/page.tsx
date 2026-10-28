import { Stack } from "@chakra-ui/react";
import { AlertTriangle, CircleSlash, Clapperboard, Clock, MessageSquareText, PauseCircle, ShieldAlert, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { SettingRow, SettingsCard, StatusPill } from "../_components/settings-ui";

/** The emails Narriflow actually sends (packages/email templates). There are no per-email preferences yet. */
const GROUPS: { title: string; icon: ReactNode; emails: { title: string; description: string; icon: ReactNode }[] }[] = [
  {
    title: "Projects",
    icon: <Clapperboard size={16} />,
    emails: [
      { title: "Clips ready", description: "A project finished generating clips.", icon: <Sparkles size={15} /> },
      { title: "No clips found", description: "Analysis found no moments that fit the settings.", icon: <CircleSlash size={15} /> },
      { title: "Needs attention", description: "An import or clip generation couldn't finish.", icon: <AlertTriangle size={15} /> },
      { title: "Project expiring", description: "About 24 hours before a project is deleted on your plan.", icon: <Clock size={15} /> },
    ],
  },
  {
    title: "Finishing and review",
    icon: <MessageSquareText size={16} />,
    emails: [
      { title: "Exports ready", description: "Automatic finishing exported clips for you to review.", icon: <Sparkles size={15} /> },
      { title: "Review activity", description: "A review is ready, approved, needs changes, or mentions you.", icon: <MessageSquareText size={15} /> },
    ],
  },
  {
    title: "Automation",
    icon: <ShieldAlert size={16} />,
    emails: [
      { title: "Automation grant paused", description: "A grant stopped itself, so nothing more goes out under it.", icon: <PauseCircle size={15} /> },
      { title: "Webhook paused", description: "Narriflow stopped sending events to an endpoint that kept failing.", icon: <PauseCircle size={15} /> },
    ],
  },
];

export default function NotificationSettingsPage() {
  return (
    <Stack gap="6">
      <PageHeader title="Notifications" description="Emails Narriflow sends to your sign-in address. They're always on for now." />
      {GROUPS.map((group) => (
        <SettingsCard key={group.title} icon={group.icon} title={group.title}>
          <Stack gap="0">
            {group.emails.map((email) => (
              <SettingRow key={email.title} icon={email.icon} title={email.title} description={email.description} control={<StatusPill tone="accent">Email · on</StatusPill>} />
            ))}
          </Stack>
        </SettingsCard>
      ))}
    </Stack>
  );
}
