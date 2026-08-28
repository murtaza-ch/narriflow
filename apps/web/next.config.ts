import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@narriflow/auth",
    "@narriflow/db",
    "@narriflow/email",
    "@narriflow/services",
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
      { source: "/dashboard", destination: "/home", permanent: true },
      { source: "/settings", destination: "/settings/profile", permanent: true },
      { source: "/settings/brand-templates", destination: "/brand-kit", permanent: true },
      { source: "/settings/social", destination: "/settings/social-accounts", permanent: true },
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
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.accounts.dev https://*.clerk.com",
              "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://*.r2.cloudflarestorage.com https://*.upstash.io",
              "frame-src 'self' https://*.clerk.accounts.dev https://*.clerk.com",
              "worker-src 'self' blob:",
            ].join("; ") + ";",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
