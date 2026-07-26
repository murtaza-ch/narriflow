import type { Metadata } from "next";
import { AtelierClient } from "./atelier-client";

export const metadata: Metadata = {
  title: "Narriflow — A week of posts. From one recording.",
  description:
    "Narriflow finds the moments worth posting, scores them for virality, captions them word for word, and publishes everywhere — in under five minutes of your time.",
};

export default function AtelierLandingPage() {
  return <AtelierClient />;
}
