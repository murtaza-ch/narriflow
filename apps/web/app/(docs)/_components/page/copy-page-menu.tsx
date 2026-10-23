"use client";

import { useEffect, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { ArrowUpRight, Check, ChevronDown, Copy, FileText } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { copyToClipboard } from "@narriflow/ui/components/code-block";
import { ActionMenu, type ActionMenuItem } from "@narriflow/ui/components/menu";
import { BrandGlyph } from "@/app/(app)/integrations/_components/brand-tile";

type Status = "idle" | "copying" | "copied" | "failed";

const LABELS: Record<Status, string> = {
  idle: "Copy page",
  copying: "Copying…",
  copied: "Copied",
  failed: "Copy failed",
};

const RESET_MS = 2000;
const external = <ArrowUpRight size={12} />;

/** Where an assistant is sent to read the page. */
const ASSISTANTS = [
  { value: "chatgpt", label: "Open in ChatGPT", brand: "chatgpt", url: "https://chatgpt.com/?hints=search&prompt=" },
  { value: "claude", label: "Open in Claude", brand: "claude", url: "https://claude.ai/new?q=" },
] as const;

function open(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Copy page as a split control: the button copies Markdown, the chevron opens the other ways to use the page. */
export function CopyPageMenu({ href }: { href: string }) {
  const [status, setStatus] = useState<Status>("idle");
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  const markdownPath = `${href}.md`;

  useEffect(() => () => clearTimeout(reset.current), []);

  async function copy() {
    clearTimeout(reset.current);
    setStatus("copying");
    try {
      const response = await fetch(markdownPath);
      if (!response.ok) throw new Error(`${markdownPath}: ${response.status}`);
      setStatus((await copyToClipboard(await response.text())) ? "copied" : "failed");
    } catch {
      setStatus("failed");
    }
    reset.current = setTimeout(() => setStatus("idle"), RESET_MS);
  }

  const items: ActionMenuItem[] = [
    { value: "copy", label: "Copy page", icon: <Copy size={14} />, onSelect: copy },
    { value: "view", label: "View as Markdown", icon: <FileText size={14} />, hint: external, onSelect: () => open(markdownPath) },
    ...ASSISTANTS.map(({ value, label, brand, url }) => ({
      value,
      label,
      icon: <BrandGlyph brand={brand} size={14} />,
      hint: external,
      onSelect: () => open(url + encodeURIComponent(`Read ${window.location.origin}${markdownPath} so I can ask questions about it.`)),
    })),
  ];

  const done = status === "copied";
  return (
    <Flex gap="0.5" flexShrink={0}>
      <Button variant="subtle" borderEndRadius="0" onClick={copy} color={status === "failed" ? "danger.fg" : done ? "accent.fg" : undefined}>
        {done ? <Check size={14} /> : <Copy size={14} />}
        {/* Every label sits in one grid cell so the button keeps the width of the longest. */}
        <chakra.span display="grid" aria-live="polite">
          {(Object.keys(LABELS) as Status[]).map((key) => (
            <chakra.span key={key} gridArea="1 / 1" visibility={key === status ? "visible" : "hidden"}>
              {LABELS[key]}
            </chakra.span>
          ))}
        </chakra.span>
      </Button>
      <ActionMenu
        ariaLabel="Page actions"
        trigger={
          <IconButton variant="subtle" borderStartRadius="0" aria-label="More page actions">
            <ChevronDown size={14} />
          </IconButton>
        }
        items={items}
      />
    </Flex>
  );
}
