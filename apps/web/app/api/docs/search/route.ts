import { searchDocs } from "@/lib/docs/search-index";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("query")?.trim();
  return Response.json(query ? await searchDocs(query) : []);
}
