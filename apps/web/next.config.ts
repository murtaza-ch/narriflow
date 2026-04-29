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
};

export default nextConfig;
