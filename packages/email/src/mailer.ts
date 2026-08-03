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

let resendClient: Resend | null = null;

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    return null;
  }

  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }

  return resendClient;
}

function getDefaultFromAddress() {
  return process.env.NARRIFLOW_EMAIL_FROM ?? "Narriflow <no-reply@narriflow.app>";
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const client = getResendClient();

  if (!client) {
    return {
      sent: false,
      reason: "RESEND_API_KEY is not configured",
    };
  }

  let content: { html: string; text?: string } | { text: string; html?: string };

  if (typeof input.html === "string" && input.html.trim().length > 0) {
    content = { html: input.html };
    if (typeof input.text === "string" && input.text.trim().length > 0) {
      content.text = input.text;
    }
  } else if (typeof input.text === "string" && input.text.trim().length > 0) {
    content = { text: input.text };
  } else {
    return {
      sent: false,
      reason: "Email body must include html or text content",
    };
  }

  try {
    const response = await client.emails.send(
      {
        from: input.from ?? getDefaultFromAddress(),
        to: input.to,
        subject: input.subject,
        ...content,
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );

    if (response.error) {
      return {
        sent: false,
        error: response.error.message,
      };
    }

    return {
      sent: true,
      id: response.data?.id,
    };
  } catch (error) {
    return {
      sent: false,
      error: error instanceof Error ? error.message : "Failed to send email",
    };
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

export async function relayClerkEmail(payload: ClerkEmailPayload): Promise<SendEmailResult> {
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

  return sendEmail({
    to,
    from: payload.from ?? payload.from_email_address ?? getDefaultFromAddress(),
    subject: payload.subject,
    html,
    text: payload.text,
  });
}
