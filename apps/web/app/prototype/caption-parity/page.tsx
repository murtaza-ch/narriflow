import { notFound } from "next/navigation";
import { CaptionParity } from "./caption-parity";

export const metadata = {
  title: "Caption parity harness",
  robots: { index: false, follow: false },
};

// PROTOTYPE — throwaway. Renders the studio caption engine at export scale
// for one preset and moment, to screenshot beside the libass burn-in frame.
export default async function Page({ searchParams }: { searchParams: Promise<{ preset?: string; t?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { preset = "bold-pop", t = "1.1" } = await searchParams;
  return <CaptionParity presetId={preset} time={Number(t)} />;
}
