import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";

export default function MarketingHomePage() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-65px)] w-full max-w-6xl flex-col items-center justify-center gap-8 px-6 py-16 text-center">
      <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
        AI Content Repurposing Platform
      </span>
      <h1 className="max-w-4xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
        Turn one long-form recording into clips, carousels, threads, and newsletters.
      </h1>
      <p className="max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
        Narriflow orchestrates ingest, transcription, moment detection, rendering, and distribution from one
        workflow.
      </p>
      <div className="flex items-center gap-3">
        <Button asChild>
          <Link href="/projects">Start in App</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/pricing">View Pricing</Link>
        </Button>
      </div>
    </main>
  );
}
