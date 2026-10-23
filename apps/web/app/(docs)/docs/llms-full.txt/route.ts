import { llmsFullTxt } from "@/lib/docs/llms";

export const dynamic = "force-static";

export async function GET() {
  return new Response(await llmsFullTxt(), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
