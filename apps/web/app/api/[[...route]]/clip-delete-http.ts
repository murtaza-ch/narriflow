import { ClipActionError } from "@narriflow/services";
import { userErrorMessage } from "@narriflow/validators";

export function clipDeleteHttpError(error: unknown) {
  if (!(error instanceof ClipActionError)) return null;
  const message = userErrorMessage(error.code) ?? "The clip could not be deleted.";
  if (error.code === "clip_storage_delete_incomplete") {
    return {
      status: 503 as const,
      body: { error: error.code, message, retryable: true as const },
    };
  }
  if (error.code === "clip_not_found") {
    return { status: 404 as const, body: { error: error.code, message } };
  }
  if (error.code === "clip_has_scheduled_posts") {
    return { status: 409 as const, body: { error: error.code, message } };
  }
  return { status: 400 as const, body: { error: error.code, message } };
}
