export function getClerkErrorMessage(error: unknown, fallbackMessage: string): string {
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
