import { Box, Flex, Grid, Stack } from "@chakra-ui/react";
import { Check, Coins, Film, Gauge, HelpCircle } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { projectService } from "@narriflow/services";
import { planDefinition } from "@narriflow/validators";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { SettingsCard, StatTile } from "../_components/settings-ui";

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
  return (
    <Stack gap="6">
      <PageHeader title="Usage" description={`${planDefinition(usage.tier).name} plan · credits renew ${renewalFormat.format(usage.renewsAt)} (UTC).`} />
      <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap="3">
        <StatTile icon={<Gauge size={14} />} label="Credits used" value={usage.usedCredits} suffix={`/ ${usage.limitCredits}`} meter={percent} hint={usage.reservedCredits > 0 ? `${usage.reservedCredits} more reserved for videos in progress` : "Nothing reserved right now"} />
        <StatTile icon={<Coins size={14} />} label="Credits left" value={usage.remainingCredits} suffix="credits" hint={`Renew ${renewalFormat.format(usage.renewsAt)}`} />
        <StatTile icon={<Film size={14} />} label="Videos processing" value={usage.inFlight} suffix={`/ ${usage.inFlightLimit} at once`} hint={`Up to ${Math.round(usage.maxUploadSeconds / 60)} min per video`} />
      </Grid>
      <SettingsCard icon={<HelpCircle size={16} />} title="How credits work">
        <Stack as="ul" gap="2.5" listStyleType="none" m="0" p="0">
          {[
            "One credit is one started minute of source video, per video: 1 second uses 1 credit, 61 seconds uses 2.",
            "Credits are reserved when you import a video and settled before transcription.",
            "They renew at 00:00 UTC on the 1st of each month. Unused credits don't roll over.",
            "Retrying a project, regenerating clips, exporting, and dubbing are free. Importing the same video as a new project isn't.",
          ].map((line) => (
            <Flex as="li" key={line} gap="2.5" align="flex-start" fontSize="13px" color="fg.muted" lineHeight="1.55">
              <Box mt="0.5" color="accent.fg" flexShrink={0}><Check size={14} /></Box>
              {line}
            </Flex>
          ))}
        </Stack>
      </SettingsCard>
    </Stack>
  );
}
