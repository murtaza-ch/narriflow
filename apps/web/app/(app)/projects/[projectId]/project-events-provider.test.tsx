import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let visible = true;
const streams: Array<{ enabled?: boolean }> = [];
mock.module("@narriflow/api-client/progress", () => ({
  useProgressStream: (_runtime: unknown, _scope: unknown, _projectId: unknown, options: { enabled?: boolean }) => {
    streams.push(options);
  },
}));
mock.module("@/lib/use-document-visible", () => ({ useDocumentVisible: () => visible }));
mock.module("@/app/_components/api-provider", () => ({
  useApiRuntime: () => ({ queryClient: {} }),
  useWorkspaceScope: () => ({ userId: "u", workspaceId: "w" }),
}));
const { ProjectEventsProvider } = await import("./project-events-provider");

function render() {
  streams.length = 0;
  renderToStaticMarkup(
    <ProjectEventsProvider projectId="p" initialSeq={0} initialEvents={[]}>
      <span />
    </ProjectEventsProvider>,
  );
  return streams.at(-1)?.enabled;
}

describe("Project events stream", () => {
  test("a visible page listens even when it shows no active work, so work started elsewhere arrives", () => {
    visible = true;
    expect(render()).toBe(true);
  });

  test("a hidden tab keeps no socket open", () => {
    visible = false;
    expect(render()).toBe(false);
  });
});
