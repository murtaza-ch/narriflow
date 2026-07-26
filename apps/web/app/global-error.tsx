"use client";

import { useEffect } from "react";

/**
 * Root error boundary — renders with NO providers, so styles stay inline.
 * Blueline graphite ground (#0E1013/#E9EBEE) with the ultramarine signal
 * (#5B6CFF) — note the dark label on the fill: white on #5B6CFF fails AA.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("global_error_boundary", error);
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
          background: "#0E1013",
          color: "#E9EBEE",
        }}
      >
        <div style={{ maxWidth: "420px", textAlign: "center" }}>
          <div
            aria-hidden="true"
            style={{
              width: "160px",
              aspectRatio: "16 / 9",
              margin: "0 auto 20px",
              border: "1px dashed #303845",
              borderRadius: "7px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#828D9C",
              fontSize: "18px",
            }}
          >
            !
          </div>
          <h1 style={{ fontSize: "20px", fontWeight: 600, margin: "0 0 12px" }}>
            Something went wrong
          </h1>
          <p
            style={{
              fontSize: "14px",
              lineHeight: 1.6,
              color: "#9AA3B0",
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
                color: "#828D9C",
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
              borderRadius: "7px",
              border: "none",
              background: "#5B6CFF",
              color: "#0E1013",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
