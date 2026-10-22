import { Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { StatBand } from "@narriflow/ui/components/stat-band";
import { projectService } from "@narriflow/services";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";

export default async function UsageSettingsPage() {
  const appUser = await admitWorkspacePage("content.view");
  const usage = await projectService.getUsageSummary(appUser);
  const percent = Math.min(
    100,
    Math.round(
      ((usage.usedMinutes + usage.reservedMinutes) /
        Math.max(1, usage.limitMinutes)) *
        100,
    ),
  );
  const minutes = (
    <Text as="span" fontSize="13px" color="fg.muted">
      min
    </Text>
  );
  return (
    <Stack gap="8">
      <PageHeader title="Usage" />
      <StatBand columns={3}>
        <StatBand.Item label="Plan" value={<Text as="span" textTransform="capitalize">{usage.tier}</Text>} />
        <StatBand.Item label="Minutes used" value={usage.usedMinutes} suffix={<Text fontSize="13px" color="fg.muted" fontVariantNumeric="tabular-nums">/ {usage.limitMinutes}</Text>} meter={percent} />
        <StatBand.Item label="Remaining" value={usage.remainingMinutes} suffix={minutes} />
        <StatBand.Item label="Reserved for videos in progress" value={usage.reservedMinutes} suffix={minutes} />
        <StatBand.Item label="Videos processing" value={usage.inFlight} suffix={<Text fontSize="13px" color="fg.muted" fontVariantNumeric="tabular-nums">/ {usage.inFlightLimit}</Text>} />
        <StatBand.Item label="Per-video limit" value={Math.round(usage.maxUploadSeconds / 60)} suffix={minutes} />
      </StatBand>
      <Text fontSize="13px" color="fg.muted" maxW="64ch">
        Source minutes reset at the start of each UTC month. A video counts once, in the month it was submitted. Deleting a project, regenerating clips, exporting, and dubbing don't change minutes used.
      </Text>
    </Stack>
  );
}
