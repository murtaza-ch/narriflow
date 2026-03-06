import { UploadWorkspace } from "./upload-workspace";

export default function UploadPage() {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Upload Workspace</h1>
        <p className="text-muted-foreground">
          Import content from direct files, YouTube, or RSS feeds. Ingest progress is available on each project.
        </p>
      </div>
      <UploadWorkspace />
    </section>
  );
}
