"use client";

import { Stack, Text } from "@chakra-ui/react";
import { CONNECTION_FAILURE_MESSAGE, describeApiFailure } from "@narriflow/api-client";
import { Button } from "@narriflow/ui/components/button";

/** A read that failed: what happened, and a retry. Nothing the person did is lost. */
export function LoadFailure({
  what,
  error,
  onRetry,
}: {
  /** What could not be loaded, e.g. "Projects". */
  what: string;
  error: unknown;
  onRetry: () => void;
}) {
  const offline = describeApiFailure(error).kind === "offline";
  return (
    <Stack gap="4" role="alert" align="flex-start">
      <Text fontSize="13px" color="fg.muted">
        {offline
          ? CONNECTION_FAILURE_MESSAGE
          : `${what} could not be loaded.`}
      </Text>
      <Button size="sm" variant="subtle" onClick={onRetry}>
        Try again
      </Button>
    </Stack>
  );
}
