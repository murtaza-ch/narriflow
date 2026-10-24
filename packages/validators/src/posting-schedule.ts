import { z } from "zod";

/** A Social Account's weekly posting slots, in the Workspace time zone. */

export const POSTING_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const postingWeekdaySchema = z.enum(POSTING_WEEKDAYS);
export type PostingWeekday = z.infer<typeof postingWeekdaySchema>;

/** Four a day is more than any platform rewards. */
export const POSTING_SCHEDULE_MAX_SLOTS = 28;

export const postingSlotSchema = z.strictObject({
  weekday: postingWeekdaySchema,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM").describe("Local time in the Workspace time zone, HH:MM"),
});

export const postingScheduleSchema = z.strictObject({
  slots: z.array(postingSlotSchema).max(POSTING_SCHEDULE_MAX_SLOTS)
    .refine((slots) => new Set(slots.map((slot) => `${slot.weekday}@${slot.time}`)).size === slots.length, "Each slot may appear once"),
});
export type PostingSchedule = z.infer<typeof postingScheduleSchema>;
export type PostingSlot = z.infer<typeof postingSlotSchema>;

/** Slots in week order, so a saved schedule reads the same however it was entered. */
export function sortedPostingSchedule(schedule: PostingSchedule): PostingSchedule {
  const order = (slot: PostingSlot) => POSTING_WEEKDAYS.indexOf(slot.weekday) * 1440 + Number(slot.time.slice(0, 2)) * 60 + Number(slot.time.slice(3));
  return { slots: [...schedule.slots].sort((a, b) => order(a) - order(b)) };
}
