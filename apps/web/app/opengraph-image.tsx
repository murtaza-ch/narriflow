import { ImageResponse } from "next/og";

export const alt =
  "Narriflow — turn long videos into short, captioned, virality-scored clips";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/*
 * Blueline OG card: porcelain ground with a faint blueprint grid, a drawn
 * ink rule, the Archivo-style bold wordmark with an ultramarine accent bar,
 * and the tagline. ImageResponse can't read theme tokens, so the hex values
 * below mirror packages/ui/src/theme.ts (bg #FBFBFC, fg #101318,
 * accent.solid #2438E8, fg.muted #585E69, grid #E9EAEE).
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#FBFBFC",
          backgroundImage:
            "linear-gradient(to right, #E9EAEE 1px, transparent 1px), linear-gradient(to bottom, #E9EAEE 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          padding: "72px 84px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Eyebrow + drawn ink rule */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: "22px",
              fontWeight: 600,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "#585E69",
            }}
          >
            AI clip studio
          </div>
          <div
            style={{
              width: "1032px",
              height: "3px",
              backgroundColor: "#101318",
              marginTop: "20px",
            }}
          />
        </div>

        {/* Wordmark with the ultramarine accent bar */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              width: "14px",
              height: "150px",
              backgroundColor: "#2438E8",
              marginRight: "36px",
            }}
          />
          <div
            style={{
              fontSize: "148px",
              fontWeight: 800,
              letterSpacing: "-0.05em",
              lineHeight: 1,
              color: "#101318",
            }}
          >
            narriflow
          </div>
        </div>

        {/* Tagline row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: "30px", color: "#585E69" }}>
            Long video in · Short clips out
          </div>
          <div
            style={{
              fontSize: "22px",
              fontWeight: 600,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "#2438E8",
            }}
          >
            narriflow.com
          </div>
        </div>
      </div>
    ),
    size,
  );
}
