import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import type { UploadSessionBrowserSnapshot } from "../_lib/upload-session-browser";
import {
  UploadSessionSecondaryActions,
  UploadSessionStatusPanel,
} from "./upload-session-status";

function snapshot(
  overrides: Partial<UploadSessionBrowserSnapshot>,
): UploadSessionBrowserSnapshot {
  return {
    phase: "uploading",
    progressPercent: 47,
    transferredBytes: 47,
    totalBytes: 100,
    bytesPerSecond: 1024 * 1024,
    etaSeconds: 53,
    message: "Uploading bytes to secure storage.",
    failureCode: null,
    canPause: true,
    canResume: false,
    canDiscard: true,
    canStartFresh: false,
    ...overrides,
  };
}

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>{node}</ChakraProvider>,
  );
}

describe("Upload Session React status", () => {
  test("renders coarse accessible progress and the active secondary controls", () => {
    const current = snapshot({});
    const markup = render(
      <>
        <UploadSessionStatusPanel snapshot={current} />
        <UploadSessionSecondaryActions
          snapshot={current}
          onPause={() => {}}
          onDiscard={() => {}}
        />
      </>,
    );

    expect(markup).toContain('<div tabindex="-1" class=');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain("Uploading");
    expect(markup).toContain("47%");
    expect(markup).toContain("Upload 40 percent complete.");
    expect(markup).toContain(">Pause<");
    expect(markup).toContain('aria-label="Discard this upload"');
  });

  test("shows saved-settings copy while Paused and removes Pause", () => {
    const current = snapshot({
      phase: "paused",
      message: "Upload paused. Re-select the exact same file to continue.",
      canPause: false,
      canResume: true,
    });
    const markup = render(
      <>
        <UploadSessionStatusPanel snapshot={current} />
        <UploadSessionSecondaryActions
          snapshot={current}
          onPause={() => {}}
          onDiscard={() => {}}
        />
      </>,
    );

    expect(markup).toContain("Paused");
    expect(markup).toContain(
      "saved title, brand, language, and generation settings",
    );
    expect(markup).not.toContain(">Pause<");
    expect(markup).toContain('aria-label="Discard this upload"');
  });

  test("makes Verifying safe to leave and exposes no destructive controls", () => {
    const current = snapshot({
      phase: "verifying",
      progressPercent: 100,
      message:
        "Narriflow is checking your upload. You may leave this page safely.",
      canPause: false,
      canDiscard: false,
    });
    const markup = render(
      <>
        <UploadSessionStatusPanel snapshot={current} />
        <UploadSessionSecondaryActions
          snapshot={current}
          onPause={() => {}}
          onDiscard={() => {}}
        />
      </>,
    );

    expect(markup).toContain("Verifying");
    expect(markup).toContain("You may leave this page safely.");
    expect(markup).not.toContain(">Pause<");
    expect(markup).not.toContain("Discard this upload");
  });

  test("uses an alert and stable recovery copy for a failed snapshot", () => {
    const markup = render(
      <UploadSessionStatusPanel
        snapshot={snapshot({
          phase: "failed",
          message:
            "Upload storage is temporarily unavailable. Your saved session is unchanged.",
          failureCode: "upload_session_unavailable",
          canPause: false,
          canDiscard: false,
        })}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Failed");
    expect(markup).toContain("Your saved session is unchanged.");
  });
});
