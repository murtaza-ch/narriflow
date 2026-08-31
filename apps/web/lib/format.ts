/**
 * Shared display formatters for dates, durations, and timecodes.
 *
 * Every formatter pins the `en-US` locale with explicit options so server
 * and client render byte-identical strings (no hydration mismatches from
 * the user's OS locale). Pure functions — safe to unit test in isolation.
 */

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function clampSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.floor(seconds);
}

/**
 * Formats a date as `Jul 7, 2026`.
 *
 * @param value - A `Date`, ISO string, or epoch milliseconds.
 * @returns The formatted date, or an empty string for invalid input.
 */
export function formatDate(value: Date | string | number): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "";
  return DATE_FORMAT.format(date);
}

/**
 * Formats a date with a 24-hour time as `Jul 7, 2026, 14:32`.
 *
 * @param value - A `Date`, ISO string, or epoch milliseconds.
 * @returns The formatted date-time, or an empty string for invalid input.
 */
export function formatDateTime(value: Date | string | number): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "";
  return DATE_TIME_FORMAT.format(date);
}

/**
 * Formats a duration compactly: `0:42`, `12:05`, `1:02:33`.
 *
 * Hours appear only when the duration reaches one hour; minutes are not
 * zero-padded unless an hours segment precedes them.
 *
 * @param seconds - Duration in seconds. Negative or non-finite input clamps to 0.
 */
export function formatDuration(seconds: number): string {
  const total = clampSeconds(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** Formats a short duration with a stable fractional precision and seconds unit. */
export function formatFractionalDuration(
  seconds: number,
  fractionDigits = 2,
): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const safeDigits = Number.isFinite(fractionDigits)
    ? Math.min(3, Math.max(0, Math.trunc(fractionDigits)))
    : 2;
  return `${safeSeconds.toFixed(safeDigits)}s`;
}

/** Formats a fractional second range without repeating the unit. */
export function formatFractionalDurationRange(
  startSeconds: number,
  endSeconds: number,
  fractionDigits = 2,
): string {
  const start = formatFractionalDuration(startSeconds, fractionDigits);
  const end = formatFractionalDuration(endSeconds, fractionDigits);
  return `${start.slice(0, -1)}–${end}`;
}

/**
 * Formats a fixed-width `HH:MM:SS` timecode: `00:00:42`.
 *
 * Always three zero-padded segments — pair with `textStyle="data"` (mono,
 * tabular numerals) so columns of timecodes align.
 *
 * @param seconds - Time offset in seconds. Negative or non-finite input clamps to 0.
 */
export function formatTimecode(seconds: number): string {
  const total = clampSeconds(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

/** Formats an upload/download rate with a stable binary unit. */
export function formatTransferRate(bytesPerSecond: number): string {
  const safeRate = Number.isFinite(bytesPerSecond)
    ? Math.max(0, bytesPerSecond)
    : 0;
  const mebibytes = safeRate / (1024 * 1024);
  if (mebibytes >= 1) return `${mebibytes.toFixed(1)} MiB/s`;
  return `${Math.round(safeRate / 1024)} KiB/s`;
}
