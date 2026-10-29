import { Suspense } from "react";
import Loading from "./loading";
import { McpConfirmationScreen } from "./confirmation-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Confirm social publication | Narriflow", robots: { index: false, follow: false } };

export default function McpPublicationConfirmation() {
  return <Suspense fallback={<Loading />}><McpConfirmationScreen /></Suspense>;
}
