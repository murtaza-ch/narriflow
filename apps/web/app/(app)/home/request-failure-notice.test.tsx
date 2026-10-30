import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";

let query = "";
mock.module("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query),
  usePathname: () => "/home",
  useRouter: () => ({ replace: () => undefined }),
}));

const { HomeRequestNotice } = await import("./request-failure-notice");

function render(search: string) {
  query = search;
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <HomeRequestNotice />
    </ChakraProvider>,
  );
}

describe("HomeRequestNotice", () => {
  test("renders nothing for a plain visit", () => {
    expect(render("")).not.toContain("role=\"status\"");
  });

  test("explains a capability redirect once, with a way to dismiss it", () => {
    const markup = render("requestFailure=capability_denied&from=upload&requestId=req-1");
    expect(markup).toContain("You need editor access to upload videos. Ask a workspace admin to change your role.");
    expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Dismiss"');
    expect(markup).not.toContain("req-1");
  });
});
