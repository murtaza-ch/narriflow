import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { saveIssueFor, type SaveIssue } from "./save-issue";
import { SaveIssueBody, type SaveIssueActions } from "./save-issue-panel";
import type { StudioSessionSnapshot } from "./studio-editing-session";

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<ChakraProvider value={system}>{node}</ChakraProvider>);

type Cloud = StudioSessionSnapshot["cloud"];
const cloud = (overrides: Partial<Cloud>): Cloud => ({
  state: "rejected",
  revision: 3,
  dirty: true,
  rejectionCode: null,
  ...overrides,
});

const actions = (overrides: Partial<SaveIssueActions> = {}): SaveIssueActions => ({
  undo: mock(() => undefined),
  upgrade: mock(() => undefined),
  retry: mock(() => undefined),
  loadLastSaved: mock(() => undefined),
  removeBroll: mock(() => undefined),
  resolveConflict: mock(() => undefined),
  openSignIn: mock(() => undefined),
  backToProject: mock(() => undefined),
  ...overrides,
});

describe("save issue from the session's cloud state", () => {
  test("a healthy save has no issue", () => {
    expect(saveIssueFor(cloud({ state: "current", dirty: false }), "ready")).toBeNull();
    expect(saveIssueFor(cloud({ state: "retrying" }), "ready")).toBeNull();
  });

  test("auth, missing clip and conflicts map to their own causes", () => {
    expect(saveIssueFor(cloud({ state: "authentication-lost" }), "ready")).toEqual({ kind: "signed-out" });
    expect(saveIssueFor(cloud({ state: "missing" }), "ready")).toEqual({ kind: "missing" });
    expect(saveIssueFor(cloud({ state: "revision-conflict" }), "conflict")).toEqual({ kind: "conflict", resolvable: true });
    expect(saveIssueFor(cloud({ state: "revision-conflict" }), "starting")).toEqual({ kind: "conflict", resolvable: false });
  });

  test("a plan refusal a higher plan lifts becomes an upgrade", () => {
    const issue = saveIssueFor(
      cloud({
        rejectionCode: "plan_feature_required",
        rejection: {
          message: "Upgrade to Creator to add scenes",
          details: { feature: "brand.scenes", currentTier: "free", requiredTier: "creator" },
        },
      }),
      "ready",
    );
    expect(issue).toMatchObject({ kind: "plan", message: "Upgrade to Creator to add scenes", prompt: { tier: "creator" } });
  });

  test("a plan refusal no plan lifts is a plain rejection", () => {
    const issue = saveIssueFor(
      cloud({
        rejectionCode: "plan_limit_reached",
        rejection: { message: "At the limit", details: { currentTier: "business", requiredTier: null, limit: "scenes" } },
      }),
      "ready",
    );
    expect(issue?.kind).toBe("rejected");
  });

  test("a deleted B-roll image names the placements to remove", () => {
    expect(
      saveIssueFor(
        cloud({
          rejectionCode: "visual_broll_asset_invalid",
          rejection: { message: null, details: { placementIds: ["a", "b"] } },
        }),
        "ready",
      ),
    ).toEqual({ kind: "deleted-broll", placementIds: ["a", "b"] });
  });

  test("other rejections use the catalog copy, never the raw code", () => {
    expect(saveIssueFor(cloud({ rejectionCode: "editor_document_empty_timeline" }), "ready")).toEqual({
      kind: "rejected",
      message: "That edit would remove the entire clip. Keep at least one frame of footage.",
    });
    expect(saveIssueFor(cloud({ rejectionCode: "something_new" }), "ready")).toEqual({
      kind: "rejected",
      message: "This change can't be saved.",
    });
  });
});

describe("save issue popover", () => {
  test("a plan refusal leads with the upgrade and keeps both ways back", () => {
    const issue: SaveIssue = {
      kind: "plan",
      message: "Upgrade to Creator to add scenes",
      prompt: { tier: "creator", headline: "Upgrade to Creator", highlight: "Scenes" },
    };
    const markup = render(<SaveIssueBody issue={issue} actions={actions()} />);
    expect(markup).toContain("Upgrade to Creator to add scenes");
    expect(markup).toContain("See plans");
    expect(markup).toContain("Try saving again");
    expect(markup).toContain("Undo last change");
    expect(markup).toContain("Load last saved version");
  });

  test("a rejection leads with undo, or the saved version when there is nothing to undo", () => {
    const issue: SaveIssue = { kind: "rejected", message: "That edit would remove the entire clip." };
    const withUndo = render(<SaveIssueBody issue={issue} actions={actions()} />);
    expect(withUndo).toContain("Undo last change");
    expect(withUndo).toContain("Try saving again");
    expect(withUndo).toContain("Load last saved version");
    const withoutUndo = render(<SaveIssueBody issue={issue} actions={actions({ undo: null })} />);
    expect(withoutUndo).not.toContain("Undo last change");
    expect(withoutUndo).toContain("Try saving again");
    expect(withoutUndo).toContain("Load last saved version");
  });

  test("a deleted B-roll image offers to remove it", () => {
    const markup = render(
      <SaveIssueBody issue={{ kind: "deleted-broll", placementIds: ["a"] }} actions={actions()} />,
    );
    expect(markup).toContain("A B-roll image was deleted.");
    expect(markup).toContain("Remove it");
  });

  test("signed out offers to sign in again", () => {
    const markup = render(<SaveIssueBody issue={{ kind: "signed-out" }} actions={actions()} />);
    expect(markup).toContain("You were signed out");
    expect(markup).toContain("Sign in again");
  });

  test("a missing clip goes back to the project", () => {
    const markup = render(<SaveIssueBody issue={{ kind: "missing" }} actions={actions()} />);
    expect(markup).toContain("no longer available");
    expect(markup).toContain("Back to project");
  });

  test("a revision conflict leads with keeping mine", () => {
    const markup = render(
      <SaveIssueBody issue={{ kind: "conflict", resolvable: true }} actions={actions()} />,
    );
    expect(markup).toContain("Load latest");
    expect(markup).toContain("Keep mine");
    expect(markup.indexOf("Keep mine")).toBeLessThan(markup.indexOf("Load latest"));
    const loading = render(
      <SaveIssueBody issue={{ kind: "conflict", resolvable: false }} actions={actions()} />,
    );
    expect(loading).toContain("Checking for a newer version");
    expect(loading).not.toContain("Load latest");
  });
});
