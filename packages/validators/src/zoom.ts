import { z } from "zod";

export const zoomTokenResponseSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive(), scope: z.string() });
export const zoomUserResponseSchema = z.object({ id: z.string().min(1), account_id: z.string().min(1), display_name: z.string().optional(), first_name: z.string().optional(), last_name: z.string().optional() });
export const zoomMeetingRecordingsSchema = z.object({ uuid: z.string(), host_id: z.string(), recording_files: z.array(z.object({ id: z.string(), status: z.string(), file_type: z.string(), download_url: z.string() })) });
export const zoomIngestPayloadSchema = z.object({ connectionId: z.string().uuid(), meetingUuid: z.string().min(1).max(200), recordingId: z.string().min(1).max(200) }).strict();
export type ZoomTokens = z.infer<typeof zoomTokenResponseSchema>;

export const zoomRecordingFileSchema = z.object({
  id: z.string().min(1).max(200),
  file_type: z.string(),
  status: z.string(),
  recording_type: z.string().optional(),
  recording_start: z.string().optional(),
  recording_end: z.string().optional(),
});

// Parse only what intake needs. Download tokens, passwords, URLs, and attendee
// information in the original webhook are deliberately discarded.
export const zoomRecordingCompletedSchema = z.object({
  event: z.literal("recording.completed"),
  event_ts: z.number().int().positive(),
  event_id: z.string().min(1).max(200).optional(),
  payload: z.object({
    account_id: z.string().min(1).max(200),
    object: z.object({
      uuid: z.string().min(1).max(200),
      host_id: z.string().min(1).max(200),
      topic: z.string().max(1000).default("Zoom recording"),
      duration: z.number().nonnegative().optional(),
      recording_files: z.array(zoomRecordingFileSchema).max(1000),
    }),
  }),
});

export const zoomNotificationSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("recording.completed"),
    eventTs: z.number().int().positive(),
    accountId: z.string(),
    hostId: z.string(),
    meetingUuid: z.string(),
    recordingId: z.string(),
    topic: z.string(),
    durationSeconds: z.number().nonnegative().nullable(),
  }),
  z.object({
    event: z.literal("app_deauthorized"),
    eventTs: z.number().int().positive(),
    accountId: z.string(),
    userId: z.string(),
  }),
]);

export type ZoomNotification = z.infer<typeof zoomNotificationSchema>;
export type ZoomRecordingNotification = Extract<ZoomNotification, { event: "recording.completed" }>;
export type ZoomRecordingFile = z.infer<typeof zoomRecordingFileSchema>;
