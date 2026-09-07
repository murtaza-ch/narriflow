import type { Metadata } from "next";
import { SystemClient } from "./system-client";

export const metadata: Metadata = {
  title: "Narriflow — The content pipeline, in one grid",
  description:
    "AI clipping, word-synced captions, virality scores, repurposing and direct publishing — the whole Narriflow pipeline, live in one grid.",
};

export default function SystemLandingPage() {
  return <SystemClient />;
}
