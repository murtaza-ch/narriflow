import type { Metadata } from "next";
import { VoltClient } from "./volt-client";

export const metadata: Metadata = {
  title: "Narriflow — One upload. A week of posts.",
  description:
    "AI moment detection, virality scores, word-synced captions and direct publishing — the whole pipeline from one upload, scored before you render.",
};

export default function VoltLandingPage() {
  return <VoltClient />;
}
