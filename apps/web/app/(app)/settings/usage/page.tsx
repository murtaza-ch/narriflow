import { Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { StatBand } from "@narriflow/ui/components/stat-band";
import { projectService } from "@narriflow/services";
import { planDefinition } from "@narriflow/validators";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";

const renewalFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export default async function UsageSettingsPage() {
  const appUser = await admitWorkspacePage("content.view");
  const usage = await projectService.getUsageSummary(appUser);
  const percent = Math.min(
    100,
    Math.round(
      ((usage.usedCredits + usage.reservedCredits) /
        Math.max(1, usage.limitCredits)) *
        100,
    ),
  );
  const unit = (label: string) => (
    <Text as="span" fontSize="13px" color="fg.muted">
      {label}
    </Text>
  );
  return (
    <Stack gap="8">
      <PageHeader title="Usage" />
      <StatBand columns={3}>
        <StatBand.Item label="Plan" value={planDefinition(usage.tier).name} />
        <StatBand.Item label="Credits used" value={usage.usedCredits} suffix={<Text fontSize="13px" color="fg.muted" fontVariantNumeric="tabular-nums">/ {usage.limitCredits}</Text>} meter={percent} />
        <StatBand.Item label="Credits left" value={usage.remainingCredits} suffix={unit("credits")} />
        <StatBand.Item label="Credits renew" value={renewalFormat.format(usage.renewsAt)} suffix={unit("UTC")} />
        <StatBand.Item label="Reserved for videos in progress" value={usage.reservedCredits} suffix={unit("credits")} />
        <StatBand.Item label="Videos processing" value={usage.inFlight} suffix={<Text fontSize="13px" color="fg.muted" fontVariantNumeric="tabular-nums">/ {usage.inFlightLimit}</Text>} />
        <StatBand.Item label="Per-video limit" value={Math.round(usage.maxUploadSeconds / 60)} suffix={unit("min")} />
      </StatBand>
      <Text fontSize="13px" color="fg.muted" maxW="64ch">
        One credit is one started minute of source video, counted per video: a 1-second video uses 1 credit and a 61-second video uses 2. Credits are reserved when you import a video and settled before transcription. They renew at 00:00 UTC on the first of each month, and unused credits don't roll over. Retrying the same project, regenerating clips, exporting, and dubbing don't use credits; importing the video again as a new project does.
      </Text>
    </Stack>
  );
}
