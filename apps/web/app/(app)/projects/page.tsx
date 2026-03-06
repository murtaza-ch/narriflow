import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { requireCurrentAppUser } from "@narriflow/auth";
import { projectService } from "@narriflow/services";

export default async function ProjectsPage() {
  const appUser = await requireCurrentAppUser();
  const projects = await projectService.listProjects(appUser.id);

  return (
    <section className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Projects</h1>
        <p className="text-muted-foreground">
          Manage imports, queue transcription, and review project progress.
        </p>
      </div>

      <div className="rounded-xl border border-border p-6">
        <p className="text-sm text-muted-foreground">
          Start new imports from the dedicated upload flow.
        </p>
        <Button className="mt-4" asChild>
          <Link href="/upload">Open Upload Workspace</Link>
        </Button>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Recent Projects</h2>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        ) : (
          <ul className="space-y-2">
            {projects.map((project) => (
              <li
                key={project.id}
                className="rounded-lg border border-border p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-medium">{project.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {project.sourceMediaUrl}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Ingest: {project.ingestStatus}
                    </p>
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
