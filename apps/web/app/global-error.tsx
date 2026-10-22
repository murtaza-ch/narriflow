"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

/**
 * Root error boundary — renders with NO providers, so styles stay inline.
 * The dark-mode graphite ground and neutral ink primary (#101010/#F2F2F2,
 * the theme's dark `bg` and `brand.solid`).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.warn(JSON.stringify({ level: "error", message: "global_error_boundary", errorName: error instanceof Error ? error.name : "UnknownError" }));
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: "#101010",
          color: "#F2F2F2",
        }}
      >
        <div style={{ maxWidth: "420px", textAlign: "center" }}>
          <div
            aria-hidden="true"
            style={{ margin: "0 auto 16px", color: "#999999", display: "flex", justifyContent: "center" }}
          >
            <TriangleAlert size={20} />
          </div>
          <h1 style={{ fontSize: "20px", fontWeight: 600, margin: "0 0 12px" }}>
            Something went wrong
          </h1>
          <p
            style={{
              fontSize: "14px",
              lineHeight: 1.6,
              color: "#AAAAAA",
              margin: "0 0 8px",
            }}
          >
            We hit an unexpected error. Please try again, and if it keeps
            happening, contact support.
          </p>
          {error.digest && (
            <p
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "12px",
                color: "#999999",
                margin: "0 0 20px",
              }}
            >
              Ref {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: 600,
              padding: "8px 16px",
              marginTop: error.digest ? 0 : "12px",
              borderRadius: "10px",
              border: "none",
              background: "#F2F2F2",
              color: "#101010",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
