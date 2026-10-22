/**
 * The public docs site (`apps/docs`). In-app pages link here for anything a
 * person reads rather than acts on. Local development points at the docs
 * preview (`bun run --cwd apps/docs docs:dev`).
 */
const DOCS_ORIGIN = (
  process.env.NEXT_PUBLIC_DOCS_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:3333" : "https://docs.narriflow.com")
).replace(/\/$/, "");

export function docsUrl(path = ""): string {
  const page = path.replace(/^\//, "");
  return page ? `${DOCS_ORIGIN}/${page}` : DOCS_ORIGIN;
}
