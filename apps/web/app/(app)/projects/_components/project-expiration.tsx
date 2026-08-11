"use client";

import { HStack, Text } from "@chakra-ui/react";
import { Clock3 } from "lucide-react";
import { useEffect, useState } from "react";

const UTC_DEADLINE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

export function formatProjectExpiryCountdown(
  expiresAt: string,
  nowMs: number,
): string {
  const remainingMs = new Date(expiresAt).getTime() - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "Expiring now";
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  if (totalMinutes < 60) return `Expires in ${totalMinutes}m`;
  const totalHours = Math.ceil(remainingMs / 3_600_000);
  if (totalHours < 24) return `Expires in ${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `Expires in ${days}d ${hours}h` : `Expires in ${days}d`;
}

export function ProjectExpiration({ expiresAt }: { expiresAt: string }) {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setNowMs(Date.now());
    update();
    const interval = window.setInterval(update, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const deadline = new Date(expiresAt);
  const exact = Number.isFinite(deadline.getTime())
    ? `${UTC_DEADLINE_FORMAT.format(deadline)} UTC`
    : expiresAt;
  const label =
    nowMs === null
      ? `Expires ${exact}`
      : formatProjectExpiryCountdown(expiresAt, nowMs);

  return (
    <HStack
      gap="1.5"
      color="danger.fg"
      title={`Permanently deleted ${exact}`}
      aria-label={`${label}. Permanently deleted ${exact}.`}
    >
      <Clock3 size={12} strokeWidth={1.75} aria-hidden="true" />
      <Text textStyle="data" fontSize="11px" fontWeight="600">
        {label}
      </Text>
    </HStack>
  );
}
