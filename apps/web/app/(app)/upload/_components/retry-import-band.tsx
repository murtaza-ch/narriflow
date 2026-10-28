"use client";

import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { userErrorMessage } from "@narriflow/validators";
import { useMutation } from "@tanstack/react-query";
import { ingestRecoveryLabel } from "@/lib/project-state";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { useUpgrade } from "../../_components/upgrade";
import { useIntake } from "../_lib/intake-context";
import { intakeFailureMessage } from "../_lib/intake-failure";
import { quotaRefusalRecovery } from "../_lib/quota-refusal";

/**
 * Step 2's ingest-failure surface: a quiet danger row with the plain-
 * language reason, a Retry import button (`POST /api/ingest/:projectId/retry`),
 * and a way out that never leaves the user stuck.
 */
export function RetryImportBand({
  projectId,
  errorCode,
  fromDrivePicker,
  onRetried,
  onSaveAndFinishLater,
  savingDraft,
  saveDraftError,
}: {
  projectId: string;
  errorCode: string | null;
  /** A Google Drive Picker import can't be retried; only a new pick recovers. */
  fromDrivePicker: boolean;
  /** The retry was accepted; the import is queued again and its stream should reopen. */
  onRetried: () => void;
  /** Persists the current Step-2 form values as a draft ContentPack (never
   *  triggers generation) before navigating away — a bare
   *  `<Link href="/projects/...">` here would silently discard whatever the
   *  user just configured in Step 2. Owned by ConfigureStep so the pending/
   *  error state is shared with the identical link under the main CTA. */
  onSaveAndFinishLater: () => void;
  savingDraft: boolean;
  saveDraftError: string | null;
}) {
  const intake = useIntake();
  const { currentTier } = useUpgrade();
  // A credits or length refusal reads true for this plan and says whether a higher one helps.
  const quota = quotaRefusalRecovery(currentTier, errorCode);
  const retry = useMutation({
    mutationFn: () => intake.actions.retryIngest(projectId),
    onSuccess: async () => {
      onRetried();
      await intake.accepted();
    },
  });

  return (
    <Flex
      align="flex-start"
      gap="3"
      borderRadius="l3"
      bg="danger.subtle"
      p="4"
    >
      <Flex
        boxSize="9"
        flexShrink={0}
        align="center"
        justify="center"
        borderRadius="l2"
        bg="danger.muted"
        color="danger.fg"
        aria-hidden
      >
        <AlertTriangle size={16} strokeWidth={2} />
      </Flex>
      <Stack gap="3.5" flex="1" minW="0">
        <Box>
          <Text fontSize="14px" fontWeight="500" color="fg" lineHeight="1.3">
            Import failed
          </Text>
          <Text fontSize="13px" color="fg.muted" lineHeight="1.5" mt="0.5">
            {quota?.message ?? userErrorMessage(errorCode) ?? "Something went wrong during the import."}
          </Text>
        </Box>
        {quota?.higherPlanNote ? <PlanLimitNotice message={quota.higherPlanNote} actionLabel="See plans" /> : null}
        <Box>
          <Flex align="center" gap="2" wrap="wrap">
            {fromDrivePicker ? (
              // The token ended with the job; only a new pick helps.
              <Button asChild size="sm">
                <Link href="/upload">{ingestRecoveryLabel(fromDrivePicker)}</Link>
              </Button>
            ) : (
              <Button type="button" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
                {retry.isPending ? (
                  <Spinner size="xs" borderTopColor="brand.contrast" />
                ) : (
                  <RotateCw size={13} aria-hidden />
                )}
                <Text as="span">Retry import</Text>
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              color="fg.muted"
              onClick={onSaveAndFinishLater}
              disabled={savingDraft}
            >
              {savingDraft ? "Saving…" : "Save settings and finish later"}
            </Button>
          </Flex>
          {retry.error ? (
            <Flex align="center" gap="1.5" mt="2.5" color="danger.fg">
              <AlertTriangle size={12} aria-hidden />
              <Text fontSize="xs">{intakeFailureMessage(retry.error, "Could not retry import. Please try again.")}</Text>
            </Flex>
          ) : null}
          {saveDraftError ? (
            <Flex align="center" gap="1.5" mt="2.5" color="danger.fg">
              <AlertTriangle size={12} aria-hidden />
              <Text fontSize="xs">{saveDraftError}</Text>
            </Flex>
          ) : null}
        </Box>
      </Stack>
    </Flex>
  );
}
