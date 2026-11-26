"use client";

/**
 * A script the browser runs as it parses the server's HTML, before the first
 * paint. Scripts React inserts on the client never run, and React warns about
 * rendering them, so the client renders it inert; the server's copy has
 * already run by then.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant script from this codebase, never user content.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
