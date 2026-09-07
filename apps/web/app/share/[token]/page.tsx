import { notFound } from "next/navigation";
import { clipExportService } from "@narriflow/services";
import { SharedExportClient } from "./shared-export-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SharedClipExportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const exported = await clipExportService.getShared(token);
  if (!exported) notFound();
  if (!exported.variants.some((variant) => variant.hasAsset && variant.downloadUrl)) {
    notFound();
  }
  return <SharedExportClient exported={exported} />;
}
