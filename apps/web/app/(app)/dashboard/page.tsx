import Link from "next/link";
import { Button } from "@clipforge/ui/components/button";

export default function DashboardPage() {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">Monitor workflow throughput, quality, and export performance.</p>
      </div>
      <Button asChild>
        <Link href="/projects">Open Projects</Link>
      </Button>
    </section>
  );
}
