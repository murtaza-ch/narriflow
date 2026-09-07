import { headers } from "next/headers";
import type { UserJSON } from "@clerk/nextjs/server";
import {
  getWebhookDeliveryLog,
  markUserDeletedByClerkId,
  recordWebhookDeliveryLog,
  syncClerkUserPayload,
} from "@narriflow/auth";
import { relayClerkEmail } from "@narriflow/email";
import { Webhook } from "svix";
import { validateWebhookEnv } from "../../../../lib/env";

export const runtime = "nodejs";

interface ClerkWebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

function getWebhookSecret(): string {
  validateWebhookEnv();
  return process.env.CLERK_WEBHOOK_SECRET as string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isClerkUserPayload(value: unknown): value is Partial<UserJSON> {
  return isRecord(value) && typeof value.id === "string";
}

function isEmailRelayPayload(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const hasRecipient =
    typeof value.to_email_address === "string" ||
    typeof value.to === "string" ||
    (Array.isArray(value.to) && value.to.every((entry) => typeof entry === "string"));

  return hasRecipient && typeof value.subject === "string";
}

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status });
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const requestHeaders = await headers();

  const svixId = requestHeaders.get("svix-id");
  const svixTimestamp = requestHeaders.get("svix-timestamp");
  const svixSignature = requestHeaders.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return jsonResponse({ error: "Missing Svix signature headers" }, 400);
  }

  let event: ClerkWebhookEvent;

  try {
    const verifier = new Webhook(getWebhookSecret());
    event = verifier.verify(rawBody, {
      "svix-id": svixId,
      "svix-signature": svixSignature,
      "svix-timestamp": svixTimestamp,
    }) as ClerkWebhookEvent;
  } catch (error) {
    return jsonResponse(
      {
        error: "Invalid webhook signature",
        message: error instanceof Error ? error.message : "Signature verification failed",
      },
      400,
    );
  }

  const existing = await getWebhookDeliveryLog("clerk", svixId);

  if (existing?.status === "success") {
    return jsonResponse({ received: true, replay: true }, 200);
  }

  try {
    if ((event.type === "user.created" || event.type === "user.updated") && isClerkUserPayload(event.data)) {
      await syncClerkUserPayload(event.data);
    } else if (event.type === "user.deleted") {
      const clerkId = typeof event.data.id === "string" ? event.data.id : null;

      if (clerkId) {
        await markUserDeletedByClerkId(clerkId);
      }
    } else if (event.type.startsWith("email.")) {
      if (isEmailRelayPayload(event.data)) {
        const relayResult = await relayClerkEmail(event.data);

        if (!relayResult.sent) {
          throw new Error(relayResult.error ?? relayResult.reason ?? "Failed to relay Clerk email with Resend");
        }
      }
    }

    const logPayload = {
      type: event.type,
      eventId: svixId,
      subjectId: typeof event.data.id === "string" ? event.data.id : null,
    };

    await recordWebhookDeliveryLog({
      provider: "clerk",
      eventId: svixId,
      eventType: event.type,
      status: "success",
      payload: logPayload,
    });

    return jsonResponse({ received: true }, 200);
  } catch (error) {
    await recordWebhookDeliveryLog({
      provider: "clerk",
      eventId: svixId,
      eventType: event.type,
      status: "failed",
      payload: {
        type: event.type,
        eventId: svixId,
        subjectId: typeof event.data.id === "string" ? event.data.id : null,
        error: error instanceof Error ? error.message : "Webhook processing failed",
      },
    });

    return jsonResponse(
      {
        error: "Webhook processing failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
}
