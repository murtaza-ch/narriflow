"use client"

import { Box, Flex, IconButton, Text, chakra } from "@chakra-ui/react"
import { Check, Copy } from "lucide-react"
import * as React from "react"
import { CODE_PALETTE } from "../code-theme"

export type CodeLanguage = "shell" | "javascript" | "python" | "text"

export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable")
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    const textarea = document.createElement("textarea")
    textarea.value = value
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    textarea.remove()
    return copied
  }
}

type Token = "plain" | "muted" | "keyword" | "string" | "variable" | "command"

// Syntax colours for both modes, restrained around the accent. Plain code
// inherits `fg`, so blocks sit on the theme's soft fill like any control.
// Written as CSS values so the docs' Shiki theme can read the same palette.
const mode = (role: keyof typeof CODE_PALETTE.light) => ({ base: CODE_PALETTE.light[role], _dark: CODE_PALETTE.dark[role] })

/** The kit tokenizer's roles on the shared code palette (`../code-theme`). */
export const CODE_TOKEN_COLORS = {
  muted: mode("comment"),
  keyword: mode("keyword"),
  string: mode("string"),
  variable: mode("constant"),
  command: mode("function"),
} as const

const TOKEN_STYLES = {
  "& .tk-muted": { color: CODE_TOKEN_COLORS.muted },
  "& .tk-keyword": { color: CODE_TOKEN_COLORS.keyword },
  "& .tk-string": { color: CODE_TOKEN_COLORS.string },
  "& .tk-variable": { color: CODE_TOKEN_COLORS.variable },
  "& .tk-command": { color: CODE_TOKEN_COLORS.command },
} as const

const KEYWORDS: Record<CodeLanguage, Set<string>> = {
  shell: new Set(["export"]),
  javascript: new Set(["const", "let", "await", "async", "return", "new", "import", "from", "function", "true", "false", "null"]),
  python: new Set(["import", "from", "def", "return", "print", "True", "False", "None", "with", "as"]),
  text: new Set(),
}

const TOKEN =
  /(?<comment>(?:^|(?<=\s))(?:#|\/\/)[^\n]*)|(?<string>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(?<variable>\$\{[^}\n]*\}|\$[A-Za-z_]\w*)|(?<flag>(?<=^|\s)--?[A-Za-z][\w-]*)|(?<number>\b\d+(?:\.\d+)?\b)|(?<word>[A-Za-z_][\w.-]*)/gm

function classify(language: CodeLanguage, code: string, match: RegExpExecArray): Token {
  const groups = match.groups ?? {}
  if (groups.comment) {
    const isHash = groups.comment.trimStart().startsWith("#")
    return isHash === (language !== "javascript") ? "muted" : "plain"
  }
  if (groups.string) return "string"
  if (groups.variable) return language === "python" ? "plain" : "variable"
  if (groups.flag) return language === "shell" ? "variable" : "plain"
  // Shell numbers are mostly ports and paths inside URLs: leave them plain.
  if (groups.number) return language === "shell" ? "plain" : "string"
  const word = groups.word ?? ""
  if (KEYWORDS[language].has(word)) return "keyword"
  if (language === "shell") {
    // The first word on a line is the command.
    const lineStart = code.lastIndexOf("\n", match.index - 1) + 1
    if (code.slice(lineStart, match.index).trim() === "") return "command"
  } else if (code[match.index + word.length] === "(") {
    return "command"
  }
  return "plain"
}

function highlight(code: string, language: CodeLanguage): React.ReactNode[] {
  if (language === "text") return [code]
  const nodes: React.ReactNode[] = []
  let last = 0
  for (const match of code.matchAll(TOKEN)) {
    const index = match.index ?? 0
    if (index > last) nodes.push(code.slice(last, index))
    const token = classify(language, code, match as RegExpExecArray)
    nodes.push(
      token === "plain" ? match[0] : (
        <span key={index} className={`tk-${token}`}>
          {match[0]}
        </span>
      ),
    )
    last = index + match[0].length
  }
  if (last < code.length) nodes.push(code.slice(last))
  return nodes
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = React.useState<"idle" | "copied" | "error">("idle")
  return (
    <>
      <IconButton
        type="button"
        variant="ghost"
        size="xs"
        color={status === "copied" ? "accent.fg" : "fg.muted"}
        _hover={{ bg: "bg.softHover", color: "fg" }}
        onClick={async () => {
          setStatus((await copyToClipboard(value)) ? "copied" : "error")
          window.setTimeout(() => setStatus("idle"), 1800)
        }}
        aria-label={status === "copied" ? "Copied" : status === "error" ? "Copy failed" : label}
        title={label}
      >
        {status === "copied" ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
      <Text srOnly aria-live="polite">
        {status === "copied" ? "Copied to clipboard" : status === "error" ? "Could not copy to clipboard" : ""}
      </Text>
    </>
  )
}

export interface CodeBlockTab {
  label: string
  code: string
  language: CodeLanguage
}

export interface CodeBlockProps {
  /** One snippet, or several shown as tabs in the header. */
  code?: string
  language?: CodeLanguage
  tabs?: CodeBlockTab[]
  /** Header label for a single snippet, e.g. "Terminal". Omit for a compact block. */
  title?: string
  copyLabel?: string
}

/**
 * Code on the theme's soft fill with a copy button. With a title or tabs it
 * gets a header row; without either it is a compact block. Shell snippets
 * show a `$` prompt that isn't copied.
 */
export function CodeBlock({ code = "", language = "text", tabs, title, copyLabel = "Copy" }: CodeBlockProps) {
  const [active, setActive] = React.useState(0)
  const current = tabs?.[active] ?? { label: title ?? "", code, language }
  const hasHeader = Boolean(tabs?.length || title)

  const body = (
    <chakra.pre
      m="0"
      flex="1"
      minW="0"
      px="4"
      pt={hasHeader ? "1" : "3"}
      pb="3"
      overflowX="auto"
      fontFamily="mono"
      fontSize="12.5px"
      lineHeight="1.7"
      color="fg"
      whiteSpace="pre"
      css={{ scrollbarWidth: "thin", ...TOKEN_STYLES }}
    >
      <code>
        {current.language === "shell" ? (
          <span className="tk-muted" style={{ userSelect: "none" }} aria-hidden="true">
            ${" "}
          </span>
        ) : null}
        {highlight(current.code, current.language)}
      </code>
    </chakra.pre>
  )

  return (
    <Box bg="bg.soft" borderRadius="12px" overflow="hidden" minW="0">
      {hasHeader ? (
        <>
          <Flex h="10" ps="2" pe="2" align="center" justify="space-between" gap="2">
            {tabs?.length ? (
              <Flex role="tablist" aria-label="Snippet language" gap="1" h="full">
                {tabs.map((tab, index) => (
                  <chakra.button
                    key={tab.label}
                    type="button"
                    role="tab"
                    aria-selected={index === active}
                    onClick={() => setActive(index)}
                    px="2"
                    h="full"
                    fontSize="12.5px"
                    fontWeight="500"
                    color={index === active ? "fg" : "fg.muted"}
                    boxShadow={index === active ? "inset 0 -1.5px 0 var(--chakra-colors-fg)" : "none"}
                    _hover={{ color: "fg" }}
                    cursor="pointer"
                  >
                    {tab.label}
                  </chakra.button>
                ))}
              </Flex>
            ) : (
              <Text px="2" fontSize="12.5px" fontWeight="500" color="fg.muted">
                {title}
              </Text>
            )}
            <CopyButton value={current.code} label={copyLabel} />
          </Flex>
          {body}
        </>
      ) : (
        <Flex align="flex-start" pe="1.5">
          {body}
          <Box pt="1.5">
            <CopyButton value={current.code} label={copyLabel} />
          </Box>
        </Flex>
      )}
    </Box>
  )
}
