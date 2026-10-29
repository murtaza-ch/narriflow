import type { Metadata } from "next";
import { SharedExportPageClient } from "./shared-export-client";

export const metadata: Metadata = {
  title: "Shared clip | Narriflow",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SharedClipExportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedExportPageClient token={token} />;
}
