import Link from "next/link";
import type { ComponentPropsWithoutRef } from "react";
import { isInternalPath, isWebLink } from "./utils";

/** Markdown links: docs paths route client-side, web links open a new tab, the rest stay plain anchors. */
export function A({ href = "", children, ...props }: ComponentPropsWithoutRef<"a">) {
  if (isInternalPath(href))
    return (
      <Link href={href} {...props}>
        {children}
      </Link>
    );
  if (isWebLink(href))
    return (
      <a href={href} target="_blank" rel="noreferrer" {...props}>
        {children}
      </a>
    );
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
