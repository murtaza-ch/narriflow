import { POSTING_WEEKDAYS, postingScheduleSchema, type PostingSchedule } from "@narriflow/validators";
import { workspaceLocalDate, workspaceLocalDateTimeToUtc } from "./calendar-time";

/** The schedule stored on an account, or null when it has none or no slots. */
export function parsePostingSchedule(value: unknown): PostingSchedule | null {
  const parsed = postingScheduleSchema.safeParse(value);
  return parsed.success && parsed.data.slots.length > 0 ? parsed.data : null;
}

/** A queue is never asked for slots further out than this. */
export const POSTING_SCHEDULE_HORIZON_DAYS = 400;

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** The schedule's slots as instants after `after`, earliest first, in the
 * Workspace time zone. Each slot is a wall-clock time, so it keeps its local
 * time across a daylight saving change: 09:00 stays 09:00. On the one day a
 * year when the clock repeats or skips a slot's time, it takes the earlier
 * repeat, or moves to the instant the skipped time would have had. */
export function* postingSlotInstants(schedule: PostingSchedule, timeZone: string, after: Date): Generator<Date> {
  if (schedule.slots.length === 0) return;
  const start = workspaceLocalDate(after, timeZone);
  let previous = after.getTime();
  for (let offset = 0; offset < POSTING_SCHEDULE_HORIZON_DAYS; offset += 1) {
    // Calendar-day arithmetic is zone-free, so a daylight saving day is still one day.
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const weekday = POSTING_WEEKDAYS[(day.getUTCDay() + 6) % 7];
    const times = schedule.slots.filter((slot) => slot.weekday === weekday).map((slot) => slot.time).sort();
    for (const time of times) {
      const local = `${pad(day.getUTCFullYear(), 4)}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}T${time}`;
      const instant = workspaceLocalDateTimeToUtc(local, timeZone, { ambiguous: "earlier", nonexistent: "shift_forward" });
      // A skipped time can move onto another slot's instant; yield each once, in order.
      if (instant.getTime() <= previous) continue;
      previous = instant.getTime();
      yield instant;
    }
  }
}

/** The next `count` slots after `after` that no active post occupies. A slot is
 * taken only by a post at exactly that instant. Fewer come back when the
 * horizon runs out. */
export function nextFreeSlots(input: {
  schedule: PostingSchedule;
  timeZone: string;
  after: Date;
  /** Epoch milliseconds of the account's other active posts. */
  occupied: ReadonlySet<number>;
  count?: number;
}): Date[] {
  const wanted = input.count ?? 1;
  const free: Date[] = [];
  for (const instant of postingSlotInstants(input.schedule, input.timeZone, input.after)) {
    if (input.occupied.has(instant.getTime())) continue;
    free.push(instant);
    if (free.length >= wanted) break;
  }
  return free;
}
