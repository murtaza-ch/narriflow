import { z } from "zod";

/** The editor timelines a clip exports as: Premiere Pro (FCP7 XML, xmeml v5),
 * Final Cut Pro and DaVinci Resolve (FCPXML 1.11), or any editor (CMX3600 EDL). */
export const TIMELINE_FORMATS = ["xmeml", "fcpxml", "edl"] as const;
export const timelineFormatSchema = z.enum(TIMELINE_FORMATS);
export type TimelineFormat = z.infer<typeof timelineFormatSchema>;
