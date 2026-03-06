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
};

export default nextConfig;
