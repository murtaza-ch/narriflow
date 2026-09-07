import type { Metadata } from "next";
import { SignalClient } from "./signal-client";

export const metadata: Metadata = {
  title: "Narriflow — Long video in. Thirty posts out.",
  description:
    "Virality-scored clips, word-synced captions, every aspect ratio, direct publishing. Narriflow turns one long recording into a month of posts.",
};

export default function SignalLandingPage() {
  return <SignalClient />;
}
