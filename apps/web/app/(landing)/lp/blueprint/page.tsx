import type { Metadata } from "next";
import { BlueprintClient } from "./blueprint-client";

export const metadata: Metadata = {
  title: "Narriflow — Every long recording hides thirty posts",
  description:
    "AI moment detection, word-synced captions, every aspect ratio, direct publishing. Narriflow turns long recordings into virality-scored clips and repurposed content.",
};

export default function BlueprintLandingPage() {
  return <BlueprintClient />;
}
