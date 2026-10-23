import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/docs/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/"] },
    sitemap: absoluteUrl("/docs/sitemap.xml"),
  };
}
