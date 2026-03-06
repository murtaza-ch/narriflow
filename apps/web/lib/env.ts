import "server-only";

const coreEnv = [
  "DATABASE_URL",
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_PUBLISHABLE_KEY",
] as const;

const webhookEnv = ["CLERK_WEBHOOK_SECRET", "RESEND_API_KEY", "NARRIFLOW_EMAIL_FROM"] as const;

let coreValidated = false;
let webhookValidated = false;

function assertEnvVars(requiredKeys: readonly string[]) {
  const missing = requiredKeys.filter((key) => !process.env[key] || process.env[key]?.trim() === "");

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

export function validateCoreEnv() {
  if (coreValidated) {
    return;
  }

  assertEnvVars(coreEnv);
  coreValidated = true;
}

export function validateWebhookEnv() {
  if (webhookValidated) {
    return;
  }

  assertEnvVars(webhookEnv);
  webhookValidated = true;
}
