export class CalendarTimeError extends Error {
  constructor(
    public readonly code:
      | "invalid_local_time"
      | "nonexistent_local_time"
      | "ambiguous_local_time",
    message: string,
  ) {
    super(message);
    this.name = "CalendarTimeError";
  }
}

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function parseLocalDateTime(value: string): LocalParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new CalendarTimeError(
      "invalid_local_time",
      "Choose a valid date and time.",
    );
  }
  const [, year, month, day, hour, minute] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  };
  const normalized = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );
  if (
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() + 1 !== parts.month ||
    normalized.getUTCDate() !== parts.day ||
    normalized.getUTCHours() !== parts.hour ||
    normalized.getUTCMinutes() !== parts.minute
  ) {
    throw new CalendarTimeError(
      "invalid_local_time",
      "Choose a valid date and time.",
    );
  }
  return parts;
}

function partsInTimezone(date: Date, timeZone: string): LocalParts {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function sameParts(left: LocalParts, right: LocalParts) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

/** The calendar date it is in the zone at this instant. */
export function workspaceLocalDate(date: Date, timeZone: string) {
  const { year, month, day } = partsInTimezone(date, timeZone);
  return { year, month, day };
}

/**
 * How a recurring local time resolves on a day the clock changes. The default
 * refuses both, because a person picking one time must choose. A standing
 * schedule instead takes the earlier of two repeated times and moves a time
 * the clock skips to the instant it would have had, the usual "compatible"
 * rule.
 */
export interface LocalTimeResolution {
  ambiguous?: "reject" | "earlier";
  nonexistent?: "reject" | "shift_forward";
}

/**
 * Converts a wall-clock value from the workspace timezone to one absolute
 * instant. Sampling offsets on both sides of the date handles DST and unusual
 * 30/45-minute zones without relying on the server's own timezone.
 */
export function workspaceLocalDateTimeToUtc(
  localDateTime: string,
  timeZone: string,
  resolution: LocalTimeResolution = {},
): Date {
  const desired = parseLocalDateTime(localDateTime);
  const desiredEpoch = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  );

  try {
    // Validate the IANA identifier before deriving candidate offsets.
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new CalendarTimeError(
      "invalid_local_time",
      "The workspace timezone is invalid. Update it in Workspace settings.",
    );
  }

  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = new Date(desiredEpoch + hours * 60 * 60 * 1000);
    const local = partsInTimezone(probe, timeZone);
    const renderedEpoch = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
    );
    offsets.add(renderedEpoch - probe.getTime());
  }

  const candidates = [...offsets]
    .map((offset) => new Date(desiredEpoch - offset))
    .filter((candidate) => sameParts(partsInTimezone(candidate, timeZone), desired))
    .sort((left, right) => left.getTime() - right.getTime());

  if (candidates.length === 0 && resolution.nonexistent === "shift_forward") {
    // The clock skipped this time. Read it with the offset in force before the
    // skip, the smallest one around it, which lands on the instant the time would
    // have had whatever the length of the skip: an hour in most zones, half an
    // hour in Lord Howe.
    return new Date(desiredEpoch - Math.min(...offsets));
  }
  if (candidates.length === 0) {
    throw new CalendarTimeError(
      "nonexistent_local_time",
      "That local time does not exist because the clock moves forward. Choose another time.",
    );
  }
  if (candidates.length > 1 && resolution.ambiguous === "earlier") return candidates[0]!;
  if (candidates.length > 1) {
    throw new CalendarTimeError(
      "ambiguous_local_time",
      "That local time occurs twice because the clock moves back. Choose a time outside the repeated hour.",
    );
  }
  return candidates[0]!;
}
