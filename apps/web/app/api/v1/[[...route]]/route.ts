import { checkRateLimit } from "@narriflow/services";
import { handle } from "hono/vercel";
import { createRestApi } from "@/lib/rest-api/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Public REST API v1: its own Hono app with Workspace API keys only. It is not
// mounted on the browser API or listed in its session declaration inventory.
const app = createRestApi({
  checkRateLimit,
  appOrigin: () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
});

export const GET = handle(app);
export const POST = handle(app);
export const DELETE = handle(app);
