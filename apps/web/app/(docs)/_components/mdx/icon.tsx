import { Box } from "@chakra-ui/react";
import { icons } from "lucide-react";
import { type AssistantBrand, BrandGlyph } from "@/app/(app)/integrations/_components/brand-tile";

// Content names the AI assistants as icons. Claude keeps its brand orange; the
// monochrome marks take the text colour, so they read in both modes.
const BRANDS: Record<string, { brand: AssistantBrand; color?: string }> = {
  claude: { brand: "claude", color: "#D97757" },
  "claude-code": { brand: "claude-code", color: "#D97757" },
  chatgpt: { brand: "chatgpt" },
  openai: { brand: "chatgpt" },
  codex: { brand: "codex" },
  cursor: { brand: "cursor" },
};

function pascalCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

export interface IconProps {
  /** A lucide name (`rocket`) or an AI assistant (`claude`, `claude-code`, `chatgpt`, `codex`, `cursor`). */
  icon?: string;
  size?: number;
  color?: string;
}

/** Server-only: it pulls in lucide's whole icon map, so client components take an `<Icon>` as a prop. Unknown names render nothing. */
export function Icon({ icon, size = 16, color }: IconProps) {
  if (!icon) return null;
  const brand = BRANDS[icon];
  if (brand) {
    return (
      <Box as="span" display="inline-flex" flexShrink={0} color={color ?? brand.color} aria-hidden="true">
        <BrandGlyph brand={brand.brand} size={size} />
      </Box>
    );
  }
  const Lucide = (icons as Record<string, (typeof icons)[keyof typeof icons]>)[pascalCase(icon)];
  if (!Lucide) return null;
  return (
    <Box as="span" display="inline-flex" flexShrink={0} color={color} aria-hidden="true">
      <Lucide size={size} />
    </Box>
  );
}

/** The `<Icon>` MDX component: sits inline in text, in the surrounding colour unless told otherwise. */
export function InlineIcon({ icon, size = 16, color }: IconProps) {
  return (
    <Box as="span" display="inline-flex" verticalAlign="text-bottom" mx="0.5">
      <Icon icon={icon} size={Number(size)} color={color} />
    </Box>
  );
}
