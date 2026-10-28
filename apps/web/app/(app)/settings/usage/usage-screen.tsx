"use client";

import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { describeApiFailure } from "@narriflow/api-client";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { planDefinition } from "@narriflow/validators";
import { Check, Coins, Film, Gauge, HelpCircle } from "lucide-react";
import { useWorkspaceScope } from "@/app/_components/api-provider";
import { useWorkspaceBootstrap } from "../../_components/usage";
import { SettingsCard, StatTile } from "../_components/settings-ui";
import UsageLoading from "./loading";

const renewalFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** Credits for the selected Workspace this month, read from the Workspace bootstrap. */
export function UsageScreen() {
  const scope = useWorkspaceScope();
  if (!scope) return <UsageLoading />;
  return <UsageContent key={scope.workspaceId} scope={scope} />;
}

function UsageContent({ scope }: { scope: NonNullable<ReturnType<typeof useWorkspaceScope>> }) {
  const bootstrap = useWorkspaceBootstrap(scope);
  if (bootstrap.isError) {
    const offline = describeApiFailure(bootstrap.error).kind === "offline";
    return (
      <Stack gap="4" role="alert" align="flex-start">
        <PageHeader title="Usage" description="Credits for this workspace." />
        <Text fontSize="13px" color="fg.muted">
          {offline
            ? "You appear to be offline. Check your connection and try again."
            : "Usage could not be loaded."}
        </Text>
        <Button size="sm" variant="subtle" onClick={() => void bootstrap.refetch()}>
          Try again
        </Button>
      </Stack>
    );
  }
  if (!bootstrap.data) return <UsageLoading />;

  const { usage } = bootstrap.data;
  const renewsAt = new Date(usage.renewsAt);
  const percent = Math.min(
    100,
    Math.round(((usage.usedCredits + usage.reservedCredits) / Math.max(1, usage.limitCredits)) * 100),
  );
  return (
    <Stack gap="6">
      <PageHeader title="Usage" description={`${planDefinition(usage.tier).name} plan · credits renew ${renewalFormat.format(renewsAt)} (UTC).`} />
      <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap="3">
        <StatTile icon={<Gauge size={14} />} label="Credits used" value={usage.usedCredits} suffix={`/ ${usage.limitCredits}`} meter={percent} hint={usage.reservedCredits > 0 ? `${usage.reservedCredits} more reserved for videos in progress` : "Nothing reserved right now"} />
        <StatTile icon={<Coins size={14} />} label="Credits left" value={usage.remainingCredits} suffix="credits" hint={`Renew ${renewalFormat.format(renewsAt)}`} />
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
