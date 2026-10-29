import { Suspense } from "react";
import Loading from "./loading";
import { McpUploadScreen } from "./upload-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upload video for your assistant | Narriflow", robots: { index: false, follow: false } };

export default function McpUploadHandoffPage() {
  return <Suspense fallback={<Loading />}><McpUploadScreen /></Suspense>;
}
