import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewAuditHistory } from "./review-audit-history";

function render(
  events: Parameters<typeof ReviewAuditHistory>[0]["events"],
) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <ReviewAuditHistory events={events} />
    </ChakraProvider>,
  );
}

describe("ReviewAuditHistory", () => {
  test("renders only stable event, target, and time labels", () => {
    const markup = render([
      {
        id: "event-1",
        kind: "guest_authenticated",
        targetId: "12345678-1234-4000-8000-123456789012",
        createdAt: "2026-08-31T10:00:00.000Z",
      },
      {
        id: "event-2",
        kind: "round_sent",
        targetId: null,
        createdAt: "2026-08-31T09:00:00.000Z",
      },
    ]);

    expect(markup).toContain("guest authenticated");
    expect(markup).toContain("Target 12345678");
    expect(markup).toContain("Round");
    expect(markup).toContain('dateTime="2026-08-31T10:00:00.000Z"');
    expect(markup).not.toContain("metadata");
  });

  test("describes an empty ledger without inventing activity", () => {
    const markup = render([]);

    expect(markup).toContain("Activity will appear");
    expect(markup).not.toContain("Target");
  });
});
