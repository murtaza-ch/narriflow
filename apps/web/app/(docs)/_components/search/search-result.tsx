import Link from "next/link";
import { chakra, Flex, Stack, Text } from "@chakra-ui/react";
import { FileText, Hash, SquareTerminal } from "lucide-react";
import type { SearchHit } from "@/lib/docs/search-index";
import { MethodBadge } from "../method-badge";

const RowLink = chakra(Link);

/** Matches the typed words where a word starts, so "prompt" marks the start of "Prompting". */
export function highlightPattern(query: string): RegExp | null {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const alternatives = words
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})`, "giu");
}

/** Matches read in the accent: the colour that marks state. */
function Highlight({ text, pattern }: { text: string; pattern: RegExp | null }) {
  if (!pattern) return text;
  const parts: React.ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > end) parts.push(text.slice(end, match.index));
    parts.push(
      <chakra.mark key={match.index} bg="transparent" color="accent.fg">
        {match[0]}
      </chakra.mark>,
    );
    end = match.index + match[0].length;
  }
  parts.push(text.slice(end));
  return parts;
}

function iconOf(hit: SearchHit) {
  if (hit.method) return SquareTerminal;
  return hit.type === "heading" ? Hash : FileText;
}

interface SearchResultProps {
  hit: SearchHit;
  id: string;
  active: boolean;
  pattern: RegExp | null;
  onHover: () => void;
  onSelect: () => void;
}

/** One result: the title (with the endpoint's method), the matching text, then where the page lives. */
export function SearchResult({ hit, id, active, pattern, onHover, onSelect }: SearchResultProps) {
  const Icon = iconOf(hit);
  return (
    <RowLink
      href={hit.url}
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      prefetch={false}
      onPointerMove={onHover}
      onClick={onSelect}
      display="flex"
      alignItems="flex-start"
      gap="3"
      px="3"
      py="2.5"
      borderRadius="l2"
      bg={active ? "bg.soft" : "transparent"}
      color="fg"
      textDecoration="none"
      cursor="pointer"
    >
      <Flex h="5" align="center" flexShrink={0} color="fg.subtle" aria-hidden="true">
        <Icon size={15} />
      </Flex>
      <Stack gap="0.5" minW="0">
        <Flex align="center" gap="2" minW="0">
          {hit.method ? <MethodBadge method={hit.method} /> : null}
          <Text fontSize="13px" fontWeight="500" lineHeight="20px" truncate>
            <Highlight text={hit.content} pattern={pattern} />
          </Text>
        </Flex>
        {hit.snippet ? (
          <Text fontSize="12px" lineHeight="1.45" color="fg.muted" truncate>
            <Highlight text={hit.snippet} pattern={pattern} />
          </Text>
        ) : null}
        <Text fontSize="12px" lineHeight="1.45" color="fg.subtle" truncate>
          {hit.breadcrumbs.join(" › ")}
        </Text>
      </Stack>
    </RowLink>
  );
}
