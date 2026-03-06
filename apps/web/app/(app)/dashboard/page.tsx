import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";

export default function DashboardPage() {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Monitor ingest throughput, transcription health, and upcoming output
          milestones.
        </p>
      </div>
      <Button asChild>
        <Link href="/upload">Start New Upload</Link>
      </Button>
    </section>
  );
}
