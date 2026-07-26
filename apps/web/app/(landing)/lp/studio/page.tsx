import type { Metadata } from "next";
import { StudioClient } from "./studio-client";

export const metadata: Metadata = {
  title: "Narriflow Studio — The editor that edits itself",
  description:
    "A session you scrub, not a page you read. AI moment detection, word-synced captions, virality-scored clips, every aspect ratio, direct publishing — Narriflow cuts the long recording so you only render the winners.",
};

export default function StudioLandingPage() {
  return <StudioClient />;
}
