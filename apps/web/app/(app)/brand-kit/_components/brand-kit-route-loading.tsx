"use client";

import { usePathname } from "next/navigation";
import BrandProfileLoading from "../[id]/loading";
import NewBrandProfileLoading from "../new/loading";
import NewStyleLoading from "../styles/new/loading";
import EditStyleLoading from "../styles/[id]/loading";
import { BrandKitListLoading } from "./brand-kit-list-loading";

export type BrandKitRoute = "list" | "profile" | "new-profile" | "style" | "new-style";

/** Which page under /brand-kit a pathname opens. */
export function brandKitRouteFor(pathname: string): BrandKitRoute {
  const [, first, second] = pathname.split("/").filter(Boolean);
  if (!first) return "list";
  if (first === "new") return "new-profile";
  if (first === "styles") return second === "new" ? "new-style" : "style";
  return "profile";
}

/**
 * The loading state of every page under /brand-kit. This route's loading.tsx
 * also wraps the profile and style pages, and Next shows it first when one of
 * them opens, so it shows the skeleton of the page being opened rather than
 * the Brand kit list's.
 */
export function BrandKitRouteLoading() {
  const route = brandKitRouteFor(usePathname() ?? "");
  switch (route) {
    case "list":
      return <BrandKitListLoading />;
    case "profile":
      return <BrandProfileLoading />;
    case "new-profile":
      return <NewBrandProfileLoading />;
    case "style":
      return <EditStyleLoading />;
    case "new-style":
      return <NewStyleLoading />;
  }
}
