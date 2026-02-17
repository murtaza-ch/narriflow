import Link from "next/link";
import { Button } from "@clipforge/ui/components/button";
import { createProjectFormAction } from "./actions";
import { projectService } from "@clipforge/services";

export default async function ProjectsPage() {
  const projects = await projectService.listProjects();

  return (
    <section className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Projects</h1>
        <p className="text-muted-foreground">Create a project and trigger workflow generation.</p>
      </div>

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

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Recent Projects</h2>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        ) : (
          <ul className="space-y-2">
            {projects.map((project) => (
              <li key={project.id} className="rounded-lg border border-border p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-medium">{project.title}</p>
                    <p className="text-xs text-muted-foreground">{project.sourceMediaUrl}</p>
                  </div>
                  <Button variant="outline" asChild>
                    <Link href={`/projects/${project.id}`}>Open</Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
