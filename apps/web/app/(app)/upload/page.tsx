import { Suspense } from "react";
import { UploadScreen } from "./_components/upload-screen";
import UploadLoading from "./loading";

// Data-free shell: configuration and resume are scoped API queries in the client screen.
export default function UploadPage() {
  return (
    <Suspense fallback={<UploadLoading />}>
      <UploadScreen />
    </Suspense>
  );
}
