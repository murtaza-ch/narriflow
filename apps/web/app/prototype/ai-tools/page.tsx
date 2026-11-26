import { notFound } from "next/navigation";
import { AiToolsHarness, type AiToolsHarnessOptions } from "./harness";

export const metadata = {
  title: "AI tools panel",
  robots: { index: false, follow: false },
};

// The Studio's AI tools panel (Add Emojis ticket 25): the real rows over mock Studio state; no API or
// sign-in.
//   ?view=states (default)   one column per row state: fresh, running, failed, applied, empty, urdu, readonly.
//   ?only=<ids>              comma-separated columns from that list.
//   ?view=rail               the real tool rail with the panel open, inside the Studio's height budget
//                            (resize the window to check short screens).
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const options: AiToolsHarnessOptions = {
    view: params.view === "rail" ? "rail" : "states",
    only: (params.only ?? "").split(",").filter(Boolean),
  };
  return <AiToolsHarness options={options} />;
}
