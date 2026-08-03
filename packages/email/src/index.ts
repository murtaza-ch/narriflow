import "server-only";

export * from "./mailer";
export {
  clipsReady,
  generationFailed,
  noClipsFound,
  type NotificationEmailTemplate,
} from "./templates";
