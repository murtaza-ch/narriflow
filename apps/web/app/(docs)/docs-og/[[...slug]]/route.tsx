import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { docsStaticParams } from "@/lib/docs/entries";
import { findPageNavigation } from "@/lib/docs/navigation";
import { findOperation } from "@/lib/docs/openapi";
import { DOCS_NAME, hrefOf } from "@/lib/docs/site";
import { docsSource } from "@/lib/docs/source";

/**
 * The social image of a docs page or endpoint, drawn in the app's light
 * look: flat porcelain, Geist, the waveform mark. Next's `opengraph-image`
 * convention cannot live under the catch-all page route, so pages point their
 * `og:image` here (`ogImageHref`). ImageResponse cannot read theme tokens, so
 * the colours mirror packages/ui/src/theme.ts (bg, fg, fg.muted, bg.soft,
 * accent.solid in light mode).
 */
export const dynamic = "force-static";
export const dynamicParams = false;
export const generateStaticParams = docsStaticParams;

const INK = "#101318";
const MUTED = "#585E69";
const SOFT = "rgba(16, 19, 24, 0.06)";
const ACCENT = "#2438E8";

let fonts: Promise<Array<{ name: string; data: Buffer; weight: 400 | 600 }>> | undefined;

function loadFonts() {
  // App-owned assets keep static image rendering independent of the install layout.
  fonts ??= Promise.all(
    ([["Geist-Regular.ttf", 400], ["Geist-SemiBold.ttf", 600]] as const).map(async ([file, weight]) => ({
      name: "Geist",
      weight,
      data: await readFile(path.join(process.cwd(), "assets/fonts/geist", file)),
    })),
  );
  return fonts;
}

/** Two lines fit; satori cannot clamp them, so cut at a word. */
function clamp(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  const href = hrefOf(slug);
  const page = docsSource.getPage(slug);
  const operation = page ? undefined : findOperation(href);
  const pageTitle = page?.data.title ?? operation?.title;
  if (!pageTitle) return new Response("Not found", { status: 404 });

  const title = href === "/docs" ? DOCS_NAME : pageTitle;
  const titleSize = title.length > 40 ? 60 : title.length > 24 ? 72 : 88;
  const description = clamp((page?.data.description ?? operation?.description ?? "").replace(/\s+/g, " "));
  const navigation = findPageNavigation(href);
  const place = [navigation?.tab, navigation?.group].filter(Boolean).join("  ›  ");

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: "72px 84px",
        backgroundColor: "#FBFBFC",
        color: INK,
        fontFamily: "Geist",
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <svg width="44" height="44" viewBox="0 0 20 20" fill="none" role="img" aria-label="Narriflow">
          <rect x="1" y="6.5" width="4" height="7" rx="2" fill={INK} />
          <rect x="8" y="1" width="4" height="18" rx="2" fill={ACCENT} />
          <rect x="15" y="4.5" width="4" height="11" rx="2" fill={INK} />
        </svg>
        <div style={{ marginLeft: 18, fontSize: 40, fontWeight: 600, letterSpacing: "-0.03em" }}>narriflow</div>
        <div
          style={{
            display: "flex",
            marginLeft: 20,
            padding: "6px 16px",
            borderRadius: 12,
            backgroundColor: SOFT,
            color: MUTED,
            fontSize: 26,
            fontWeight: 600,
          }}
        >
          Docs
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {place ? <div style={{ fontSize: 28, color: MUTED, marginBottom: 20 }}>{place}</div> : null}
        <div style={{ fontSize: titleSize, fontWeight: 600, lineHeight: 1.08, letterSpacing: "-0.035em" }}>{title}</div>
        {description ? <div style={{ marginTop: 28, fontSize: 32, lineHeight: 1.35, color: MUTED }}>{description}</div> : null}
      </div>
    </div>,
    { width: 1200, height: 630, fonts: await loadFonts() },
  );
}
