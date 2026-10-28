import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectListItem } from "../_lib/api";

// Static markup runs no command; the hooks the delete button reads are stand-ins.
mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
mock.module("@/app/_components/api-provider", () => ({
  useApiRuntime: () => ({}),
  useWorkspaceScope: () => null,
}));

const { ProjectCard } = await import("./project-card");
const queryClient = new QueryClient();

function project(expiresAt: string | null): ProjectListItem {
  return {
    id: "018f5f6a-4c31-7c75-9a4f-8f74f977bc10",
    title: "Founder interview",
    sourceType: "upload",
    sourceInput: null,
    sourceStorageKey: null,
    sourceDurationSeconds: 600,
    createdAt: "2026-08-20T00:00:00.000Z",
    expiresAt,
    clipCount: 3,
    avgViralityScore: null,
    progress: { status: "completed", label: "Ready", active: false },
    transcript: null,
  } as unknown as ProjectListItem;
}

function render(item: ProjectListItem, canDelete = false) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ChakraProvider value={system}>
        <ProjectCard project={item} canDelete={canDelete} />
      </ChakraProvider>
    </QueryClientProvider>,
  );
}

describe("ProjectCard", () => {
  test("offers delete only to members who can edit", () => {
    expect(render(project(null), true)).toContain(`Delete &quot;Founder interview&quot;`);
    expect(render(project(null))).not.toContain("Delete &quot;");
  });


  test("shows the project's own deletion deadline as an absolute UTC label before mount", () => {
    const markup = render(project("2026-08-22T03:00:00.000Z"));
    expect(markup).toContain("Expires Aug 22 at 03:00 UTC");
    expect(markup).toContain("Permanently deleted Aug 22 at 03:00 UTC");
  });

  test("omits the expiration for a retained project", () => {
    const markup = render(project(null));
    expect(markup).toContain("Founder interview");
    expect(markup).not.toContain("Expires");
    expect(markup).not.toContain("Permanently deleted");
  });
});
