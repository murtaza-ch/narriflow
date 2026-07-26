// Shared status vocabulary for the projects list and project detail.
// Plain module (no "use client") so server components can import the map —
// data constants exported from a client module become client-reference
// proxies on the server and read as undefined.

export type BadgeStatus =
  | "queued"
  | "pending"
  | "processing"
  | "ready"
  | "completed"
  | "failed"
  | "error";

export const STATUS_CONFIG: Record<
  string,
  { status: BadgeStatus; label: string }
> = {
  ready: { status: "ready", label: "Ready" },
  processing: { status: "processing", label: "Processing" },
  queued: { status: "queued", label: "Queued" },
  pending: { status: "pending", label: "Pending" },
  uploading: { status: "processing", label: "Uploading" },
  downloading: { status: "processing", label: "Downloading" },
  normalizing: { status: "processing", label: "Normalizing" },
  failed: { status: "failed", label: "Failed" },
};
