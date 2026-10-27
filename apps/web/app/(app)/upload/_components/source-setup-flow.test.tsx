import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceSetupFlow } from "./source-setup-flow";

function render(canContinue: boolean, blockedReason: string | null) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <SourceSetupFlow
        title=""
        onTitleChange={() => {}}
        sourceLabel="Video file"
        sourcePreview={null}
        metadata={null}
        mode="clip"
        canContinue={canContinue}
        blockedReason={blockedReason}
        locked={false}
        onChangeSource={() => {}}
        configuration={() => null}
        actions={() => null}
      />
    </ChakraProvider>,
  );
}

describe("SourceSetupFlow", () => {
  test("names what a disabled Continue is waiting for", () => {
    expect(render(false, "Name the project to continue.")).toContain("Name the project to continue.");
  });

  test("keeps the usual hint once Continue is available", () => {
    const markup = render(true, "Name the project to continue.");
    expect(markup).not.toContain("Name the project to continue.");
    expect(markup).toContain("Your upload starts after you confirm your settings.");
  });
});
