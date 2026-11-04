import { Resend } from "resend";

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  idempotencyKey?: string;
}

export interface SendEmailResult {
  sent: boolean;
  id?: string;
  error?: string;
  reason?: string;
}

interface ClerkEmailPayload {
  to_email_address?: string;
  to?: string | string[];
  subject?: string;
  body?: string;
  html?: string;
  text?: string;
  from?: string;
  from_email_address?: string;
}

/** Provider settings, passed by the caller: the Worker has no process environment to read. */
export interface MailerConfig {
  apiKey?: string;
  from?: string;
}

const DEFAULT_FROM = "Narriflow <no-reply@narriflow.app>";

/** The mail settings in a service environment. */
export function mailerConfig(environment: Readonly<Record<string, string | undefined>>): MailerConfig {
  return { apiKey: environment.RESEND_API_KEY?.trim() || undefined, from: environment.NARRIFLOW_EMAIL_FROM?.trim() || undefined };
}

function notSent(result: { reason?: string; error?: string }): SendEmailResult {
  console.warn(JSON.stringify({ level: "warn", message: "email_not_sent", ...result }));
  return { sent: false, ...result };
}

export async function sendEmail(input: SendEmailInput, config: MailerConfig): Promise<SendEmailResult> {
  if (!config.apiKey) {
    return notSent({ reason: "RESEND_API_KEY is not configured" });
  }
  const client = new Resend(config.apiKey);

  let content: { html: string; text?: string } | { text: string; html?: string };

  if (typeof input.html === "string" && input.html.trim().length > 0) {
    content = { html: input.html };
    if (typeof input.text === "string" && input.text.trim().length > 0) {
      content.text = input.text;
    }
  } else if (typeof input.text === "string" && input.text.trim().length > 0) {
    content = { text: input.text };
  } else {
    return notSent({ reason: "Email body must include html or text content" });
  }

  try {
    const response = await client.emails.send(
      {
        from: input.from ?? config.from ?? DEFAULT_FROM,
        to: input.to,
        subject: input.subject,
        ...content,
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );

    if (response.error) {
      return notSent({ error: response.error.message });
    }

    return {
      sent: true,
      id: response.data?.id,
    };
  } catch (error) {
    return notSent({ error: error instanceof Error ? error.message : "Failed to send email" });
  }
}

function getRecipient(payload: ClerkEmailPayload): string | string[] | null {
  if (payload.to_email_address) {
    return payload.to_email_address;
  }

  if (typeof payload.to === "string" || Array.isArray(payload.to)) {
    return payload.to;
  }

  return null;
}

function getHtml(payload: ClerkEmailPayload): string {
  if (typeof payload.html === "string" && payload.html.trim().length > 0) {
    return payload.html;
  }

  if (typeof payload.body === "string" && payload.body.trim().length > 0) {
    return payload.body;
  }

  if (typeof payload.text === "string") {
    return `<pre>${payload.text}</pre>`;
  }

  return "";
}

export async function relayClerkEmail(
  payload: ClerkEmailPayload,
  options: { idempotencyKey?: string } & MailerConfig,
): Promise<SendEmailResult> {
  const to = getRecipient(payload);

  if (!to) {
    return {
      sent: false,
      reason: "Email payload does not include a recipient",
    };
  }

  if (!payload.subject || payload.subject.trim().length === 0) {
    return {
      sent: false,
      reason: "Email payload does not include a subject",
    };
  }

  const html = getHtml(payload);

  return sendEmail(
    {
      to,
      from: payload.from ?? payload.from_email_address,
      subject: payload.subject,
      html,
      text: payload.text,
      idempotencyKey: options.idempotencyKey,
    },
    options,
  );
}
