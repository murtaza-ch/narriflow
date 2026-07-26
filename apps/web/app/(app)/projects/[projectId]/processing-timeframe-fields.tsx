"use client";

import { useMemo, useState } from "react";
import { Box, Grid, Text } from "@chakra-ui/react";
import { NumberInput } from "@narriflow/ui/components/number-input";
import { ProcessingTimeline } from "../../_shared/processing-timeline";

interface ProcessingTimeframeFieldsProps {
  sourceDurationSec: number | null;
  defaultStartSec?: number | null;
  defaultEndSec?: number | null;
}

export function ProcessingTimeframeFields({
  sourceDurationSec,
  defaultStartSec = null,
  defaultEndSec = null,
}: ProcessingTimeframeFieldsProps) {
  const durationSec =
    typeof sourceDurationSec === "number" && sourceDurationSec > 0
      ? sourceDurationSec
      : null;
  const [touched, setTouched] = useState(false);
  const [startSec, setStartSec] = useState(defaultStartSec ?? 0);
  const [endSec, setEndSec] = useState(defaultEndSec ?? durationSec ?? 0);

  const shouldSubmitTimeline = useMemo(() => {
    if (!durationSec) return false;
    if (defaultStartSec !== null || defaultEndSec !== null) return true;
    return touched && (startSec > 0 || endSec < durationSec);
  }, [defaultEndSec, defaultStartSec, durationSec, endSec, startSec, touched]);

  if (!durationSec) {
    return (
      <Box>
        <Text textStyle="eyebrow" color="fg.subtle" mb="1.5">
          Processing timeframe
        </Text>
        <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap="2">
          <NumberInput
            size="sm"
            min={0}
            step={1}
            defaultValue={
              defaultStartSec === null ? undefined : String(defaultStartSec)
            }
            placeholder="Start seconds"
            inputProps={{ name: "processingStartSec" }}
          />
          <NumberInput
            size="sm"
            min={0}
            step={1}
            defaultValue={
              defaultEndSec === null ? undefined : String(defaultEndSec)
            }
            placeholder="End seconds"
            inputProps={{ name: "processingEndSec" }}
          />
        </Grid>
      </Box>
    );
  }

  return (
    <Box>
      <ProcessingTimeline
        durationSec={durationSec}
        startSec={startSec}
        endSec={endSec}
        disabled={false}
        hasSource
        onChange={(start, end) => {
          setTouched(true);
          setStartSec(start);
          setEndSec(end);
        }}
      />
      {shouldSubmitTimeline && (
        <>
          <input
            type="hidden"
            name="processingStartSec"
            value={String(Math.max(0, Math.floor(startSec)))}
          />
          <input
            type="hidden"
            name="processingEndSec"
            value={String(
              Math.min(
                durationSec,
                Math.max(Math.floor(startSec) + 1, Math.floor(endSec)),
              ),
            )}
          />
        </>
      )}
    </Box>
  );
}
