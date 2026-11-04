import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let visible = true;
const streams: Array<{ enabled?: boolean }> = [];
mock.module("@narriflow/api-client/progress", () => ({
  invalidateAfterProgress: async () => {},
  invalidateAfterTerminalProgress: async () => {},
  useProgressStream: (_runtime: unknown, _scope: unknown, _projectId: unknown, options: { enabled?: boolean }) => {
    streams.push(options);
  },
}));
mock.module("@/lib/use-document-visible", () => ({ useDocumentVisible: () => visible }));
mock.module("@/app/_components/api-provider", () => ({
  useApiRuntime: () => ({ queryClient: {} }),
  useWorkspaceScope: () => ({ userId: "u", workspaceId: "w" }),
}));
const { ProjectEventsProvider, shouldRefreshWithoutStream } = await import("./project-events-provider");

function render() {
  streams.length = 0;
  renderToStaticMarkup(
    <ProjectEventsProvider projectId="p" initialSeq={0} initialEvents={[]} working={false}>
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

describe("Refreshing without a live stream", () => {
  const running = { working: true, visible: true, streamOpen: false };

  test("work in progress keeps updating when the socket cannot connect", () => {
    expect(shouldRefreshWithoutStream(running)).toBe(true);
  });

  test("an open stream already delivers updates", () => {
    expect(shouldRefreshWithoutStream({ ...running, streamOpen: true })).toBe(false);
  });

  test("an idle page and a hidden tab make no requests", () => {
    expect(shouldRefreshWithoutStream({ ...running, working: false })).toBe(false);
    expect(shouldRefreshWithoutStream({ ...running, visible: false })).toBe(false);
  });
});
