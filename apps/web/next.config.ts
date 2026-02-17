import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@clipforge/db", "@clipforge/services", "@clipforge/ui", "@clipforge/validators"],
};

export default nextConfig;
