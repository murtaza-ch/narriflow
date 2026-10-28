"use client";

import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Box, chakra, Flex, Stack, Text } from "@chakra-ui/react";
import { userErrorMessage, type WorkflowStatus } from "@narriflow/validators";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Hourglass,
  LoaderCircle,
} from "lucide-react";
import {
  type ActivityStep,
  dayKey,
  dayLabel,
  formatClock,
  formatElapsed,
  groupActivitySteps,
  groupStepsByDay,
} from "./project-activity";
import { useProjectEvents } from "./project-events-provider";
import { PanelHeader } from "./panel-header";
import { SoftBar } from "./soft-bar";
import { EmptyState } from "@narriflow/ui/components/empty-state";

const STATUS_STYLE: Record<
  WorkflowStatus,
  { label: string; icon: ReactNode; fg: string; mark: string; pill: string }
> = {
  queued: { label: "Queued", icon: <Clock size={15} />, fg: "fg.muted", mark: "bg.soft", pill: "bg.soft" },
  waiting: { label: "Waiting", icon: <Hourglass size={15} />, fg: "fg.muted", mark: "bg.soft", pill: "bg.soft" },
  running: {
    label: "Running",
    icon: <LoaderCircle size={15} />,
    fg: "accent.fg",
    mark: "accent.subtle",
    pill: "accent.subtle",
  },
  completed: { label: "Completed", icon: <Check size={15} />, fg: "fg.muted", mark: "bg.soft", pill: "bg.soft" },
  partial: {
    label: "Partial",
    icon: <CircleAlert size={15} />,
    fg: "warning.fg",
    mark: "warning.subtle",
    pill: "warning.subtle",
  },
  failed: {
    label: "Failed",
    icon: <AlertTriangle size={15} />,
    fg: "danger.fg",
    mark: "danger.subtle",
    pill: "danger.subtle",
  },
};

/**
 * The browser's time zone and today's date in it. The server and the first
 * client render use UTC with no "today", so hydration matches; the browser's
 * values replace them straight after.
 */
const subscribeNever = () => () => {};
function readBrowserClock(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return `${zone}|${dayKey(Date.now(), zone)}`;
}
function useBrowserClock(): { zone: string; today: string | null } {
  const snapshot = useSyncExternalStore(subscribeNever, readBrowserClock, () => "UTC|");
  const [zone = "UTC", today = ""] = snapshot.split("|");
  return { zone, today: today || null };
}

function StepRow({ step, zone }: { step: ActivityStep; zone: string }) {
  const [open, setOpen] = useState(false);
  const { latest } = step;
  const style = STATUS_STYLE[latest.status];
  const expandable = step.updates.length > 1;
  const running = latest.status === "running";
  const clock = (iso: string) => formatClock(iso, zone);
  const startedMinute = step.queuedAt ? clock(step.queuedAt) : null;
  const endedMinute = clock(latest.emittedAt);
  const time =
    step.finished && startedMinute && startedMinute !== endedMinute
      ? `${startedMinute} → ${endedMinute}`
      : endedMinute;

  const content = (
    <Flex align="center" gap="3.5" px="4" py="3.5" textAlign="left">
      <Flex
        boxSize="8"
        align="center"
        justify="center"
        borderRadius="full"
        bg={style.mark}
        color={style.fg}
        flexShrink={0}
        aria-hidden="true"
      >
        {running ? <Box display="flex" animation="spin">{style.icon}</Box> : style.icon}
      </Flex>
      <Stack gap="1.5" minW="0" flex="1">
        <Flex align="center" gap="2.5" minW="0">
          <Text fontSize="14px" fontWeight="550" color="fg" truncate>
            {step.label}
          </Text>
          <Text
            px="2"
            py="1"
            borderRadius="full"
            bg={style.pill}
            color={style.fg}
            fontSize="11px"
            lineHeight="1"
            flexShrink={0}
          >
            {style.label}
          </Text>
        </Flex>
        {running && latest.progress > 0 && latest.progress < 100 ? (
          <Flex align="center" gap="2.5" maxW="360px">
            <SoftBar value={latest.progress} aria-label={`${step.label} progress`} />
            <Text fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums" flexShrink={0}>
              {Math.round(latest.progress)}%
            </Text>
          </Flex>
        ) : null}
        {latest.errorCode ? (
          <Text fontSize="12px" color="danger.fg">
            {userErrorMessage(latest.errorCode)}
          </Text>
        ) : step.durationSec !== null ? (
          <Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums">
            Took {formatElapsed(step.durationSec)}
          </Text>
        ) : null}
      </Stack>
      <Text textStyle="data" fontSize="12px" color="fg.subtle" flexShrink={0}>
        {time}
      </Text>
      <Box
        w="4"
        flexShrink={0}
        color="fg.subtle"
        display="flex"
        aria-hidden="true"
        transition="transform 160ms ease"
        transform={open ? "rotate(180deg)" : undefined}
        visibility={expandable ? "visible" : "hidden"}
      >
        <ChevronDown size={16} />
      </Box>
    </Flex>
  );

  return (
    <Box bg="bg.subtle" borderRadius="l2" overflow="hidden">
      {expandable ? (
        <chakra.button
          type="button"
          display="block"
          w="full"
          cursor="pointer"
          transition="background 120ms ease"
          _hover={{ bg: "bg.soft" }}
          _focusVisible={{ outline: "2px solid", outlineColor: "accent.solid", outlineOffset: "-2px" }}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {content}
        </chakra.button>
      ) : (
        content
      )}
      {open ? (
        <Stack gap="1.5" ps="62px" pe="4" pb="4">
          {step.updates.map((update) => (
            <Flex key={update.seq} align="baseline" gap="3" fontSize="12px" color="fg.muted">
              <Text textStyle="data" fontSize="12px" color="fg.subtle" w="64px" flexShrink={0}>
                {formatClock(update.emittedAt, zone, true)}
              </Text>
              <Text>
                {STATUS_STYLE[update.status].label}
                {update.status === "running" && update.progress > 0 && update.progress < 100 ? (
                  <Text as="span" color="fg.subtle" fontVariantNumeric="tabular-nums">
                    {" "}
                    · {Math.round(update.progress)}%
                  </Text>
                ) : null}
              </Text>
            </Flex>
          ))}
        </Stack>
      ) : null}
    </Box>
  );
}

/**
 * Activity tab — one row per workflow step (all the updates of a stage of a
 * run folded together), under day headings. The EventSource connection itself
 * lives in ProjectEventsProvider (mounted once per project page around the
 * tabs) so the processing checklist consumes the same stream without a second
 * connection; this component is a pure consumer and stays mounted regardless
 * of active tab.
 */
export function ProjectEvents() {
  const { events } = useProjectEvents();
  const { zone, today } = useBrowserClock();

  const days = useMemo(
    () => groupStepsByDay(groupActivitySteps(events), zone),
    [events, zone],
  );

  return (
    <Stack gap="6">
      <PanelHeader
        icon={<Activity size={20} />}
        title="Activity"
        badge={
          <Flex
            align="center"
            gap="1.5"
            px="2"
            py="1"
            borderRadius="full"
            bg="accent.subtle"
            color="accent.fg"
            fontSize="12px"
            lineHeight="1"
          >
            <Box boxSize="1.5" borderRadius="full" bg="accent.solid" />
            Live
          </Flex>
        }
        description="Recent workflow steps, newest first."
      />

      {days.length === 0 ? (
        <EmptyState
          icon={<Activity />}
          title="Waiting for workflow updates"
          description="Steps show up here as they run."
        />
      ) : (
        <Stack gap="6">
          {days.map(({ day, steps }) => (
            <Stack key={day} gap="2">
              <Text fontSize="12px" fontWeight="500" color="fg.muted" ps="1">
                {dayLabel(day, today)}
              </Text>
              <Stack gap="1.5">
                {steps.map((step) => (
                  <StepRow key={step.key} step={step} zone={zone} />
                ))}
              </Stack>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
