import { isClerkRuntimeError } from "@clerk/nextjs/errors";

export function getClerkErrorMessage(error: unknown, fallbackMessage: string): string {
  if (isClerkRuntimeError(error)) {
    if (error.code === "passkey_retrieval_cancelled") return "Passkey sign-in was cancelled. Try again or choose another method.";
    if (error.code === "passkey_registration_cancelled") return "Passkey creation was cancelled. You can try again when you're ready.";
    return fallbackMessage;
  }
  if (!error || typeof error !== "object") {
    return fallbackMessage;
  }

  const maybeErrors = (error as { errors?: unknown[] }).errors;

  if (!Array.isArray(maybeErrors) || maybeErrors.length === 0) {
    return fallbackMessage;
  }

  const firstError = maybeErrors[0];

  if (!firstError || typeof firstError !== "object") {
    return fallbackMessage;
  }

  const message = (firstError as { longMessage?: string; message?: string }).longMessage;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }

  const shortMessage = (firstError as { longMessage?: string; message?: string }).message;
  if (typeof shortMessage === "string" && shortMessage.length > 0) {
    return shortMessage;
  }

  return fallbackMessage;
}
