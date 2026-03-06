import Redis from "ioredis";
import { getCurrentAppUser } from "@narriflow/auth";
import { getWorkflowChannel, getWorkflowEventsSince, projectService } from "@narriflow/services";

export const runtime = "nodejs";

function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(
  req: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { projectId } = await context.params;
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return new Response(JSON.stringify({ error: "Project not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (access === "forbidden") {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const channel = getWorkflowChannel(projectId);
  const redisUrl = process.env.UPSTASH_REDIS_URL;
  const sinceSeq = Number(req.url ? new URL(req.url).searchParams.get("sinceSeq") ?? "0" : "0");
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          sseEvent("connected", {
            projectId,
            channel,
            sinceSeq,
            ts: new Date().toISOString(),
          }),
        ),
      );

      const cachedEvents = await getWorkflowEventsSince(projectId, Number.isFinite(sinceSeq) ? sinceSeq : 0);
      for (const event of cachedEvents) {
        controller.enqueue(encoder.encode(sseEvent("workflow.stage.updated", event)));
      }

      let subscriber: Redis | null = null;

      if (redisUrl) {
        try {
          subscriber = new Redis(redisUrl, {
            maxRetriesPerRequest: null,
            enableOfflineQueue: false,
            lazyConnect: true,
          });

          await subscriber.connect();
          await subscriber.subscribe(channel);

          subscriber.on("message", (incomingChannel, message) => {
            if (incomingChannel !== channel) {
              return;
            }

            try {
              const payload = JSON.parse(message) as unknown;
              controller.enqueue(encoder.encode(sseEvent("workflow.stage.updated", payload)));
            } catch {
              // Ignore malformed messages from pub/sub.
            }
          });
        } catch {
          // Redis unavailable — degrade gracefully. Cached events already sent.
          subscriber?.disconnect();
          subscriber = null;
        }
      }

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(sseEvent("ping", { ts: Date.now() })));
      }, 15000);

      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        if (subscriber) {
          void subscriber.unsubscribe(channel).finally(() => subscriber?.disconnect());
        }
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
