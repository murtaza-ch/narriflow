import { notFound } from "next/navigation";
import DashboardPrototype from "./prototype";
import "./prototype.css";

export const metadata = {
  title: "Dashboard design study",
  robots: { index: false, follow: false },
};

export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { view } = await searchParams;
  return <DashboardPrototype initialView={view} />;
}
