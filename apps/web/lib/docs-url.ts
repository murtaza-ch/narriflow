/** A docs page in this app (`app/(docs)`), e.g. `docsUrl("api/n8n")` → `/docs/api/n8n`. */
export function docsUrl(path = ""): string {
  const page = path.replace(/^\//, "");
  return page ? `/docs/${page}` : "/docs";
}
