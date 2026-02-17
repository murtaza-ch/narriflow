import { Button } from "@clipforge/ui/components/button";
import { createProjectFormAction } from "./actions/project";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 px-6 py-16">
      <section className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">ClipForge Stack Bootstrap</h1>
        <p className="text-sm text-muted-foreground">
          Next.js 16 + Hono + Server Actions + shared package architecture.
        </p>
      </section>

      <form action={createProjectFormAction} className="space-y-4 rounded-xl border border-border p-6">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="title">
            Project Title
          </label>
          <input
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            id="title"
            name="title"
            placeholder="My podcast episode"
            required
            type="text"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="sourceMediaUrl">
            Source Media URL
          </label>
          <input
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            id="sourceMediaUrl"
            name="sourceMediaUrl"
            placeholder="https://example.com/media.mp4"
            required
            type="url"
          />
        </div>

        <Button type="submit">Create Project</Button>
      </form>
    </main>
  );
}
