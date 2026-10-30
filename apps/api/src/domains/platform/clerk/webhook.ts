/** Clerk (Svix) delivery adapter. Collaborators are injected; `runtime.ts` wires the real ones. */

export interface ClerkWebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface EmailRelayResult {
  sent: boolean;
  error?: string;
  reason?: string;
}

export interface ClerkWebhookDependencies {
  webhookSecret: string;
  /** Verifies the signature over the exact raw text and returns the parsed event; throws otherwise. */
  verify(
    rawBody: string,
    headers: { id: string; timestamp: string; signature: string },
    secret: string,
  ): ClerkWebhookEvent;
  /** Atomically takes the right to process this delivery; see `claimWebhookDelivery`. */
  claimDelivery(input: {
    provider: "clerk";
    eventId: string;
    eventType: string;
  }): Promise<"claimed" | "replay" | "in_progress">;
  recordDeliveryLog(input: {
    provider: "clerk";
    eventId: string;
    eventType: string;
    status: string;
    payload?: unknown;
  }): Promise<unknown>;
  syncUser(payload: Record<string, unknown>): Promise<unknown>;
  markUserDeleted(clerkId: string): Promise<unknown>;
  /** `deliveryId` is the verified Svix message id: the same email event always carries the same id. */
  relayEmail(payload: Record<string, unknown>, deliveryId: string): Promise<EmailRelayResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function isClerkEvent(value: unknown): value is ClerkWebhookEvent {
  return isRecord(value) && typeof value.type === "string" && isRecord(value.data);
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function subjectId(event: ClerkWebhookEvent): string | null {
  return typeof event.data.id === "string" ? event.data.id : null;
}

async function applyEvent(
  event: ClerkWebhookEvent,
  deliveryId: string,
  deps: ClerkWebhookDependencies,
): Promise<void> {
  if (event.type === "user.created" || event.type === "user.updated") {
    if (typeof event.data.id === "string") {
      await deps.syncUser(event.data);
    }
  } else if (event.type === "user.deleted") {
    const clerkId = subjectId(event);
    if (clerkId) {
      await deps.markUserDeleted(clerkId);
    }
  } else if (event.type.startsWith("email.") && isEmailRelayPayload(event.data)) {
    const relayResult = await deps.relayEmail(event.data, deliveryId);

    if (!relayResult.sent) {
      throw new Error(relayResult.error ?? relayResult.reason ?? "Failed to relay Clerk email with Resend");
    }
  }
}

/**
 * Handles one Clerk delivery. The caller must pass a request whose body was
 * read under the webhook byte limit and not parsed or reserialized: the
 * signature covers the exact bytes. A delivery already recorded as `success`
 * is acknowledged without re-applying it; one being processed by another
 * handler is refused (409) so Clerk redelivers it.
 */
export async function handleClerkWebhook(
  request: Request,
  deps: ClerkWebhookDependencies,
): Promise<Response> {
  const rawBody = await request.text();

  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return jsonResponse({ error: "Missing Svix signature headers" }, 400);
  }

  let event: ClerkWebhookEvent;
  try {
    const verified: unknown = deps.verify(
      rawBody,
      { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      deps.webhookSecret,
    );
    if (!isClerkEvent(verified)) {
      return jsonResponse({ error: "Invalid webhook payload" }, 400);
    }
    event = verified;
  } catch {
    return jsonResponse(
      { error: "Invalid webhook signature", message: "Signature verification failed" },
      400,
    );
  }

  // Overlapping deliveries of one event must not both run its side effects.
  const claim = await deps.claimDelivery({ provider: "clerk", eventId: svixId, eventType: event.type });
  if (claim === "replay") {
    return jsonResponse({ received: true, replay: true }, 200);
  }
  if (claim === "in_progress") {
    return jsonResponse({ error: "Delivery is already being processed" }, 409);
  }

  try {
    await applyEvent(event, svixId, deps);

    await deps.recordDeliveryLog({
      provider: "clerk",
      eventId: svixId,
      eventType: event.type,
      status: "success",
      payload: { type: event.type, eventId: svixId, subjectId: subjectId(event) },
    });

    return jsonResponse({ received: true }, 200);
  } catch (error) {
    await deps.recordDeliveryLog({
      provider: "clerk",
      eventId: svixId,
      eventType: event.type,
      status: "failed",
      payload: {
        type: event.type,
        eventId: svixId,
        subjectId: subjectId(event),
        error: error instanceof Error ? error.message : "Webhook processing failed",
      },
    });

    // Clerk only needs the 5xx to redeliver; the cause stays in the delivery log.
    return jsonResponse(
      { error: "Webhook processing failed", message: "Delivery could not be processed" },
      500,
    );
  }
}
