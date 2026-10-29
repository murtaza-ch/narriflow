import path from "node:path";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

// The browser calls the API origin directly (Bearer fetch, streams, review and
// share reads), so it must be allowed by connect-src. The build fails loudly
// without it rather than shipping pages that cannot reach their data.
function apiOrigin(): string {
  const value = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!value) {
    if (process.env.NODE_ENV === "production") throw new Error("NEXT_PUBLIC_API_URL is required to build the web app");
    return "http://localhost:4000";
  }
  return new URL(value).origin;
}
const API_ORIGIN = apiOrigin();

const reviewScriptSource = process.env.NODE_ENV === "development"
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.accounts.dev https://*.clerk.com"
  : "script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://*.clerk.com";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: [
    "@narriflow/api-client",
    "@narriflow/ui",
    "@narriflow/validators",
  ],
  experimental: {
    optimizePackageImports: ["@chakra-ui/react"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "img.youtube.com" },
    ],
  },
  async redirects() {
    return [
      { source: "/settings", destination: "/settings/profile", permanent: true },
      { source: "/developers/api", destination: "/docs/api/introduction", permanent: true },
    ];
  },
  async rewrites() {
    return [
      // Every docs page is also served as Markdown: at its URL plus ".md",
      // and at its own URL for agents that ask for text/markdown.
      { source: "/docs.md", destination: "/docs-markdown" },
      { source: "/docs/:path*.md", destination: "/docs-markdown/:path*" },
      {
        source: "/docs/:path*",
        has: [{ type: "header", key: "accept", value: ".*text/markdown.*" }],
        destination: "/docs-markdown/:path*",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // Minimal, non-breaking CSP: the enforceable clickjacking win.
          // TODO: enumerate Clerk/R2/analytics origins and add
          // script-src / connect-src / img-src / media-src directives.
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none';",
          },
          // Report-Only: the browser evaluates this stricter policy and reports
          // violations but never blocks anything, so it is safe to ship. Hosts
          // are derived from images.remotePatterns (i.ytimg.com, img.youtube.com)
          // and the app's real backends: Clerk (auth), Cloudflare R2 (media),
          // Upstash (rate limiting). Promote to enforced once violations are
          // reviewed. TODO(follow-up): add a report-to/report-uri endpoint.
          {
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              "base-uri 'self'",
              "object-src 'none'",
              "frame-ancestors 'none'",
              "img-src 'self' data: blob: https://i.ytimg.com https://img.youtube.com https://*.r2.cloudflarestorage.com",
              "media-src 'self' blob: https://*.r2.cloudflarestorage.com",
              "font-src 'self' data:",
              "style-src 'self' 'unsafe-inline'",
              // Google Identity Services and Picker, and the Dropbox Chooser, for the upload page's cloud pickers.
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.accounts.dev https://*.clerk.com https://accounts.google.com https://apis.google.com https://www.dropbox.com https://www.youtube.com",
              `connect-src 'self' ${API_ORIGIN} https://*.clerk.accounts.dev https://*.clerk.com https://*.r2.cloudflarestorage.com https://accounts.google.com`,
              "frame-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://accounts.google.com https://docs.google.com https://content.googleapis.com https://www.dropbox.com https://www.youtube.com https://www.youtube-nocookie.com",
              "worker-src 'self' blob:",
            ].join("; ") + ";",
          },
        ],
      },
      {
        source: "/integrations/mcp/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
      {
        source: "/review/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https://*.clerk.accounts.dev https://*.clerk.com; media-src 'self' blob: https://*.r2.cloudflarestorage.com; font-src 'self' data:; style-src 'self' 'unsafe-inline'; ${reviewScriptSource}; connect-src 'self' ${API_ORIGIN} https://*.clerk.accounts.dev https://*.clerk.com; frame-src 'self' https://*.clerk.accounts.dev https://*.clerk.com; worker-src 'self' blob:;`,
          },
        ],
      },
      {
        // A docs URL serves HTML or Markdown depending on Accept (see rewrites).
        source: "/docs/:path*",
        headers: [{ key: "Vary", value: "Accept" }],
      },
      {
        source: "/api/review/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
        ],
      },
    ];
  },
};

// fumadocs-mdx types its argument with whichever copy of `next` the install
// linked as its optional peer. Vercel's restored cache once linked an older
// patch release, whose NextConfig type doesn't match ours; it only uses the type.
export default createMDX()(nextConfig as never);
