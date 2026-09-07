"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Box, chakra, Flex, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { userErrorMessage } from "@narriflow/validators";
import { retryIngestFormAction } from "../../projects/actions";
import { authenticatedActionResultMessage } from "@/lib/authenticated-request-browser";

type RetryState = { ok: boolean; error: string | null };
const initialState: RetryState = { ok: true, error: null };

/**
 * Step 2's ingest-failure surface: a contained danger panel with the plain-
 * language reason, a Retry import button (the existing
 * `retryIngestFormAction` from projects/actions.ts — imported, not edited),
 * and a way out that never leaves the user stuck.
 */
export function RetryImportBand({
  projectId,
  errorCode,
  onSaveAndFinishLater,
  savingDraft,
  saveDraftError,
}: {
  projectId: string;
  errorCode: string | null;
  /** Persists the current Step-2 form values as a draft ContentPack (never
   *  triggers generation) before navigating away — a bare
   *  `<Link href="/projects/...">` here would silently discard whatever the
   *  user just configured in Step 2. Owned by ConfigureStep so the pending/
   *  error state is shared with the identical link under the main CTA. */
  onSaveAndFinishLater: () => void;
  savingDraft: boolean;
  saveDraftError: string | null;
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<RetryState, FormData>(
    async (_previous, formData) => {
      const result = await retryIngestFormAction(formData);
      if (result.ok) {
        router.refresh();
        return { ok: true, error: null };
      }
      return {
        ok: false,
        error: authenticatedActionResultMessage(
          result,
          "Could not retry import. Please try again.",
        ),
      };
    },
    initialState,
  );

  return (
    <Box
      position="relative"
      overflow="hidden"
      borderRadius="l2"
      bg="danger.subtle"
      borderWidth="1px"
      borderColor="danger.muted"
      px="4"
      py="3.5"
    >
      <Stack gap="3">
        <Flex align="flex-start" gap="2.5">
          <Box color="danger.fg" mt="0.5" flexShrink={0}>
            <AlertTriangle size={14} strokeWidth={2} />
          </Box>
          <Text fontSize="13px" color="danger.fg" fontWeight="500">
            {userErrorMessage(errorCode) ?? "This import failed."}
          </Text>
        </Flex>
        <form action={formAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <Flex align="center" gap="3" wrap="wrap">
            <Button type="submit" size="sm" variant="outline" disabled={isPending}>
              {isPending ? <Spinner size="xs" borderTopColor="accent.fg" /> : null}
              <Text ms={isPending ? "1" : "0"}>Retry import</Text>
            </Button>
            <chakra.button
              type="button"
              onClick={onSaveAndFinishLater}
              disabled={savingDraft}
              fontSize="12.5px"
              color="fg"
              textDecoration="underline"
              textUnderlineOffset="3px"
              transition="color 120ms ease"
              cursor={savingDraft ? "default" : "pointer"}
              opacity={savingDraft ? 0.6 : 1}
              _hover={savingDraft ? undefined : { color: "fg.muted" }}
            >
              {savingDraft ? "Saving…" : "Save settings and finish later"}
            </chakra.button>
          </Flex>
          {state.error ? (
            <Flex align="center" gap="1.5" mt="2" color="danger.fg">
              <AlertTriangle size={12} aria-hidden />
              <Text fontSize="xs">{state.error}</Text>
            </Flex>
          ) : null}
          {saveDraftError ? (
            <Flex align="center" gap="1.5" mt="2" color="danger.fg">
              <AlertTriangle size={12} aria-hidden />
              <Text fontSize="xs">{saveDraftError}</Text>
            </Flex>
          ) : null}
        </form>
      </Stack>
    </Box>
  );
}
