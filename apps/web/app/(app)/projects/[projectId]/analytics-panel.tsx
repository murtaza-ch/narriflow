import { Box, Stack, Text } from "@chakra-ui/react";
import { BarChart3 } from "lucide-react";
import { StatBand } from "@narriflow/ui/components/stat-band";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import type { AnalyticsSnapshot } from "@narriflow/validators";

export function AnalyticsPanel({
  analytics,
}: {
  analytics: AnalyticsSnapshot;
}) {
  const { totals } = analytics;
  const allZero =
    totals.rendersCompleted === 0 &&
    totals.downloadsOpened === 0 &&
    totals.dubsCompleted === 0 &&
    totals.dubDownloadsOpened === 0 &&
    totals.socialScheduled === 0 &&
    totals.socialPosted === 0 &&
    totals.socialFailed === 0;

  if (allZero) {
    return (
      <EmptyState
        icon={<BarChart3 size={22} aria-hidden />}
        title="No activity yet"
        description="Renders, downloads, dubs and social publishing will be counted here as this project moves through the pipeline."
      />
    );
  }

  return (
    <Stack gap="5">
      <Box>
        <Text textStyle="eyebrow" color="fg.subtle">
          Analytics
        </Text>
        <Text mt="0.5" fontSize="xs" color="fg.muted">
          First-party export and scheduling activity for this project.
        </Text>
      </Box>

      <StatBand columns={4}>
        <StatBand.Item label="Completed renders" value={totals.rendersCompleted} />
        <StatBand.Item label="Download links opened" value={totals.downloadsOpened} />
        <StatBand.Item label="Dubs completed" value={totals.dubsCompleted} />
        <StatBand.Item label="Dub downloads" value={totals.dubDownloadsOpened} />
      </StatBand>

      <StatBand columns={4}>
        <StatBand.Item label="Social schedules" value={totals.socialScheduled} />
        <StatBand.Item label="Social posted" value={totals.socialPosted} />
        <StatBand.Item
          label="Social failed"
          value={totals.socialFailed}
          suffix={
            totals.socialFailed > 0 ? (
              <Text textStyle="eyebrow" color="danger.fg">
                failed
              </Text>
            ) : undefined
          }
        />
      </StatBand>
    </Stack>
  );
}
