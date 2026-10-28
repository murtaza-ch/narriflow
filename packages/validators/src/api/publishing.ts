import { z } from "zod";
import { postingScheduleSchema } from "../posting-schedule";
import { socialPlatformSchema, socialPostStatusSchema } from "../social";

// Shared request schemas of the publishing routes. Posts, proposals, recovery
// and bulk scheduling reuse the existing domain schemas
// (`confirmSocialPublicationSchema`, `acceptSocialPostProposalSchema`, ...).

const uuid = z.string().uuid();

/** Calendar queries pad the view window by this much so a post near an edge shows in every Workspace time zone. */
export const CALENDAR_WINDOW_PADDING_MS = 36 * 60 * 60 * 1000;
/** The widest calendar window one request may ask for (a six-week month grid with its padding fits). */
export const CALENDAR_WINDOW_MAX_MS = 120 * 24 * 60 * 60 * 1000;

/** `POST /api/social/oauth/start/:platform`: where the connected account should return to (a safe path, checked again by the server). */
export const socialOAuthStartRequestSchema = z.strictObject({
  redirect: z.string().max(512).optional(),
});
export type SocialOAuthStartRequest = z.infer<typeof socialOAuthStartRequestSchema>;

/** Facebook Page selection tokens are the 32 to 128 character URL-safe OAuth state. */
export const FACEBOOK_SELECTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
export const facebookSelectionTokenParamSchema = z.object({
  token: z.string().regex(FACEBOOK_SELECTION_TOKEN_PATTERN),
});
export const completeFacebookPageSelectionSchema = z.strictObject({
  pageId: z.string().min(1).max(200),
});

/** Unknown values are ignored (the filter is dropped), as the calendar always did for a stale link. */
const lenient = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .max(40)
    .optional()
    .transform((value) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? (parsed.data as z.output<T>) : undefined;
    });

const calendarFiltersShape = {
  status: lenient(socialPostStatusSchema),
  platform: lenient(socialPlatformSchema),
  account: uuid.optional(),
  project: uuid.optional(),
};

const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const windowShape = { from: instant, to: instant };

function isBoundedWindow(value: { from: Date; to: Date }) {
  // An unparsable instant already carries its own issue; do not stack a second failure on it.
  if (!(value.from instanceof Date) || !(value.to instanceof Date)) return true;
  const span = value.to.getTime() - value.from.getTime();
  return span >= 0 && span <= CALENDAR_WINDOW_MAX_MS;
}
const WINDOW_ISSUE = { message: "Ask for a window of at most 120 days", path: ["to"] };

/** `GET /api/workspace/calendar/posts`: scheduled posts whose time falls in exactly [from, to]. */
export const calendarPostsQuerySchema = z
  .object({ ...windowShape, ...calendarFiltersShape })
  .refine(isBoundedWindow, WINDOW_ISSUE);
export type CalendarPostsQuery = z.input<typeof calendarPostsQuerySchema>;

/** `GET /api/publishing/calendar`: the aggregate for a view window; the server pads it by `CALENDAR_WINDOW_PADDING_MS`. */
export const publishingCalendarQuerySchema = z
  .object({ ...windowShape, ...calendarFiltersShape })
  .refine(
    (value) =>
      !(value.to instanceof Date) ||
      isBoundedWindow({ from: value.from, to: new Date(value.to.getTime() + 2 * CALENDAR_WINDOW_PADDING_MS) }),
    WINDOW_ISSUE,
  );
export type PublishingCalendarQuery = z.input<typeof publishingCalendarQuerySchema>;

/** `GET /api/workspace/calendar/composer-options` */
export const composerOptionsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  cursor: z.string().max(512).optional(),
});

/** `GET /api/projects/:id/social-posts`: `active=1` limits to in-flight posts (or just the `tracked` ids). */
export const projectSocialPostsQuerySchema = z.object({
  active: z.string().max(8).optional(),
  tracked: z.string().max(4_000).optional(),
  cursor: z.string().max(512).optional(),
});

/** `PUT /api/social/accounts/:accountId/posting-schedule`: null (or no slots) clears the schedule. */
export const savePostingScheduleRequestSchema = z.strictObject({
  schedule: postingScheduleSchema.nullable(),
});

/** `POST /api/social/proposals/accept-all`: continue from the last proposal tried until `nextCursor` is null. */
export const acceptAllProposalsRequestSchema = z.strictObject({
  after: uuid.nullable().default(null),
});

/** What the Performance page can offer when nothing has been measured yet. */
export type PerformanceEmptyNextStep = "publish" | "connect" | "ask" | null;
