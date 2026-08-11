import "server-only";

export * from "./mailer";
export {
  clipsReady,
  generationFailed,
  noClipsFound,
  projectExpiring,
  type NotificationEmailTemplate,
} from "./templates";
