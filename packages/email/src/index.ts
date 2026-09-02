import "server-only";

export * from "./mailer";
export {
  clipsReady,
  generationFailed,
  noClipsFound,
  projectExpiring,
  reviewNotification,
  type NotificationEmailTemplate,
} from "./templates";
