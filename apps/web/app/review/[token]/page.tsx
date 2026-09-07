import type { Metadata } from "next";
import { ReviewClient } from "./review-client";

export const metadata: Metadata = {
  title: "Private review | Narriflow",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ReviewClient token={token} />;
}
