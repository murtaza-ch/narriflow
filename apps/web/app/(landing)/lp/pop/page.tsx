import type { Metadata } from "next";
import { PopClient } from "./pop-client";

export const metadata: Metadata = {
  title: "Narriflow — Turn long videos into a week of posts",
  description:
    "AI moment detection, word-synced captions, virality scores and direct publishing. One recording in, a week of platform-ready posts out.",
};

export default function PopLandingPage() {
  return <PopClient />;
}
