import { isValidElement, type ReactNode } from "react";

/** Plain text of a rendered subtree; code blocks use it for the copy button. */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** Web links open in a new tab; hashes, paths and app schemes (mailto:, cursor://) stay as they are. */
export function isWebLink(href: string): boolean {
  return /^(?:https?:)?\/\//i.test(href);
}

export function isInternalPath(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}
