import { notFound } from "next/navigation";
import { UIKIT } from "./ui-kit";

export const metadata = {
  title: "Chakra UI kit · Narriflow",
  robots: { index: false, follow: false },
};

export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <UIKIT />;
}
