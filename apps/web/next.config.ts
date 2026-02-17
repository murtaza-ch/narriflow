import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@narriflow/db", "@narriflow/services", "@narriflow/ui", "@narriflow/validators"],
};

export default nextConfig;
