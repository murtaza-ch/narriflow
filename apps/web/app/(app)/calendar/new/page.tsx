import Link from "next/link";
import { Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Button } from "@narriflow/ui/components/button";
import { requireWorkspaceAppUser } from "@/lib/workspace";
import { workspaceLibraryService, workspaceService } from "@narriflow/services";
import { CalendarPostForm } from "./calendar-post-form";

export default async function NewCalendarPostPage() {
  const appUser = await requireWorkspaceAppUser("publishing.manage");
  const [options, workspace] = await Promise.all([
    workspaceLibraryService.getCalendarComposerOptions(appUser.actorUserId, appUser.workspaceId),
    workspaceService.getWorkspace(appUser.actorUserId, appUser.workspaceId),
  ]);
  return (
    <Stack gap="8" maxW="760px">
      <PageHeader eyebrow="Calendar" title="Schedule a workspace clip" description="Choose an existing completed clip, then select a connected account and publish time." actions={<Button variant="outline" asChild><Link href="/calendar">Cancel</Link></Button>} />
      <CalendarPostForm clips={options.clips} accounts={options.accounts} timezone={workspace?.timezone ?? "UTC"} />
    </Stack>
  );
}
