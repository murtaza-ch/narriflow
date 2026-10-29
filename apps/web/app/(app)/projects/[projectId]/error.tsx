"use client";

import { useEffect } from "react";
import { ProjectLoadError } from "./project-load-error";

export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.warn(JSON.stringify({ level: "error", message: "project_error_boundary", errorName: error instanceof Error ? error.name : "UnknownError" }));
  }, [error]);

  return <ProjectLoadError onRetry={reset} supportId={error.digest} />;
}
