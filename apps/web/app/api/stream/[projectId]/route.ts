import Redis from "ioredis";
import { getWorkflowChannel } from "@clipforge/services";

export const runtime = "nodejs";

function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(
  req: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  const channel = getWorkflowChannel(projectId);
  const redisUrl = process.env.UPSTASH_REDIS_URL;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          sseEvent("connected", {
            projectId,
            channel,
            ts: new Date().toISOString(),
          }),
        ),
      );

      let subscriber: Redis | null = null;

      if (redisUrl) {
        subscriber = new Redis(redisUrl, {
          maxRetriesPerRequest: null,
          enableOfflineQueue: false,
        });

        await subscriber.subscribe(channel);

        subscriber.on("message", (incomingChannel, message) => {
          if (incomingChannel !== channel) {
            return;
          }

          controller.enqueue(encoder.encode(sseEvent("workflow.stage.updated", JSON.parse(message))));
        });
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
