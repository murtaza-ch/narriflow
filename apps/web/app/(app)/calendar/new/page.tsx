import Link from "next/link";
import { Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Button } from "@narriflow/ui/components/button";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { workspaceLibraryService, workspaceService } from "@narriflow/services";
import { CalendarPostForm } from "./calendar-post-form";
import { workspaceAllowsCapability } from "@narriflow/validators";

export default async function NewCalendarPostPage() {
  const appUser = await admitWorkspacePage("publishing.manage");
  const [options, workspace] = await Promise.all([
    workspaceLibraryService.getCalendarComposerOptions(appUser.actorUserId, appUser.workspaceId,
    ),
    workspaceService.getWorkspace(appUser.actorUserId, appUser.workspaceId),
  ]);
  return (
    <Stack gap="8" maxW="760px">
      <PageHeader eyebrow="Calendar" title="Schedule a workspace clip" description="Choose an existing clip, then select a connected account and publish time. Narriflow freezes and prepares the exact revision." actions={<Button variant="outline" asChild><Link href="/calendar">Cancel</Link></Button>} />
      <CalendarPostForm clips={options.clips} accounts={options.accounts} timezone={workspace?.timezone ?? "UTC"} canOverrideReview={workspaceAllowsCapability({ role: appUser.role, status: appUser.status }, "review.override")} />
    </Stack>
  );
}
