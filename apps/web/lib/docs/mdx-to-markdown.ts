/**
 * Turns an MDX page body into plain Markdown, converting Mintlify components
 * the way Mintlify's own `.md` export does (https://mintlify.com/docs/ai/markdown-export):
 * callouts become GitHub alerts, cards and accordions become blockquotes,
 * steps become numbered titles, and wrappers such as Tabs or CodeGroup
 * disappear. Code blocks are never touched.
 */

type Attrs = Record<string, string | true>;

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Attrs;
  start: number;
  end: number;
}

interface Element {
  name: string;
  attrs: Attrs;
  start: number;
  end: number;
  /** Between the opening and closing tags; undefined for `<Tag />`. */
  inner?: string;
}

const ALERTS: Record<string, string> = {
  Note: "NOTE",
  Info: "NOTE",
  Tip: "TIP",
  Check: "TIP",
  Warning: "WARNING",
  Danger: "CAUTION",
};

function endOfBraces(md: string, from: number): number {
  let depth = 0;
  for (let i = from; i < md.length; i++) {
    const c = md[i];
    if (c === '"' || c === "'" || c === "`") {
      const close = md.indexOf(c, i + 1);
      if (close === -1) return -1;
      i = close;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

function readTag(md: string, start: number): Tag | undefined {
  const head = /<(\/)?([A-Z][\w.]*)/y;
  head.lastIndex = start;
  const match = head.exec(md);
  const name = match?.[2];
  if (!match || !name) return undefined;
  const attrs: Attrs = {};
  let i = head.lastIndex;
  for (;;) {
    while (/\s/.test(md[i] ?? "")) i++;
    if (md[i] === ">" || (md[i] === "/" && md[i + 1] === ">")) {
      const selfClosing = md[i] === "/";
      return { name, closing: Boolean(match[1]), selfClosing, attrs, start, end: i + (selfClosing ? 2 : 1) };
    }
    const key = /[\w:-]+/y;
    key.lastIndex = i;
    const attribute = key.exec(md)?.[0];
    if (!attribute) return undefined;
    i = key.lastIndex;
    if (md[i] !== "=") {
      attrs[attribute] = true;
      continue;
    }
    i++;
    const quote = md[i];
    if (quote === '"' || quote === "'") {
      const close = md.indexOf(quote, i + 1);
      if (close === -1) return undefined;
      attrs[attribute] = md.slice(i + 1, close);
      i = close + 1;
    } else if (quote === "{") {
      const close = endOfBraces(md, i);
      if (close === -1) return undefined;
      attrs[attribute] = md.slice(i + 1, close - 1).replace(/^["'`]|["'`]$/g, "");
      i = close;
    } else return undefined;
  }
}

/** The index after the code at `i` (a fenced block or an inline span), or `i + 1` when the backtick is plain text. */
function skipCode(md: string, i: number): number {
  let run = 0;
  while (md[i + run] === "`") run++;
  const lineStart = md.lastIndexOf("\n", i - 1) + 1;
  const fenced = run >= 3 && md.slice(lineStart, i).trim() === "";
  const closer = fenced ? new RegExp(`^[ \\t]*\`{${run},}[ \\t]*$`, "m") : new RegExp(`(?<!\`)\`{${run}}(?!\`)`);
  const rest = md.slice(i + run);
  const found = closer.exec(rest);
  if (!found) return fenced ? md.length : i + run;
  return i + run + found.index + found[0].length;
}

/** The outermost components of `md`, each with the text between its tags. */
function topLevelElements(md: string, from = 0): Element[] {
  const found: Element[] = [];
  let open: { tag: Tag; depth: number } | undefined;
  for (let i = from; i < md.length; ) {
    if (md[i] === "`") {
      i = skipCode(md, i);
      continue;
    }
    const tag = md[i] === "<" ? readTag(md, i) : undefined;
    if (!tag) {
      i++;
      continue;
    }
    i = tag.end;
    if (!open) {
      if (tag.closing) continue;
      if (tag.selfClosing) found.push({ name: tag.name, attrs: tag.attrs, start: tag.start, end: tag.end });
      else open = { tag, depth: 1 };
    } else if (!tag.selfClosing) {
      open.depth += tag.closing ? -1 : 1;
      if (open.depth === 0) {
        const { tag: first } = open;
        found.push({ name: first.name, attrs: first.attrs, start: first.start, end: tag.end, inner: md.slice(first.end, tag.start) });
        open = undefined;
      }
    }
  }
  // A tag that never closes, like a bare `<UUID>` in prose, is plain text.
  return open ? [...found, ...topLevelElements(md, open.tag.end)] : found;
}

function dedent(text: string): string {
  const lines = text.replace(/^\n+|\s+$/g, "").split("\n");
  const indents = lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const indent = Math.min(...indents, Number.POSITIVE_INFINITY);
  return Number.isFinite(indent) ? lines.map((line) => line.slice(indent)).join("\n") : "";
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function titled(title: string | undefined, href: string | undefined): string {
  if (!title) return "";
  return href ? `**[${title}](${href})**` : `**${title}**`;
}

function text(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface Steps {
  count: number;
}

function render({ name, attrs }: Element, inner: string, steps: Steps): string {
  const title = text(attrs.title);
  const alert = ALERTS[name];
  if (alert) return quote(`[!${alert}]\n\n${inner}`);
  switch (name) {
    case "Step": {
      const number = text(attrs.stepNumber) ?? String(++steps.count);
      return [`**${title ? `${number}. ${title}` : `${number}.`}**`, inner].filter(Boolean).join("\n\n");
    }
    case "Tab":
      return [titled(title, undefined), inner].filter(Boolean).join("\n\n");
    case "Card": {
      const href = text(attrs.href);
      const link = !title && href ? `[Open](${href})` : "";
      return quote([titled(title, href), inner, link].filter(Boolean).join("\n\n"));
    }
    case "Accordion":
    case "Expandable":
      return quote([titled(title, undefined), inner].filter(Boolean).join("\n\n"));
    case "ParamField":
    case "ResponseField": {
      const field = text(attrs.path) ?? text(attrs.query) ?? text(attrs.body) ?? text(attrs.header) ?? text(attrs.name) ?? "";
      const flags = ["required", "deprecated"].filter((flag) => attrs[flag]);
      const fallback = text(attrs.default);
      const summary = [`**${field}**`, text(attrs.type) && `\`${text(attrs.type)}\``, ...flags, fallback && `default: \`${fallback}\``];
      return [summary.filter(Boolean).join(" "), inner].filter(Boolean).join("\n\n");
    }
    case "Tooltip":
      return `${inner} (${text(attrs.tip) ?? ""})`;
    case "Frame":
      return [inner, text(attrs.caption)].filter(Boolean).join("\n\n");
    default:
      return [titled(title, text(attrs.href)), inner].filter(Boolean).join("\n\n");
  }
}

function convert(md: string, steps: Steps): string {
  let out = "";
  let position = 0;
  for (const element of topLevelElements(md)) {
    out += md.slice(position, element.start);
    const inner = element.inner === undefined ? "" : convert(dedent(element.inner), element.name === "Steps" ? { count: 0 } : steps);
    const rendered = render(element, inner, steps);
    // A component in the middle of a line, like Tooltip, stays inline; blocks get a blank line around them.
    const inline = md.slice(md.lastIndexOf("\n", element.start - 1) + 1, element.start).trim() !== "";
    out += inline ? rendered : `\n\n${rendered}\n\n`;
    position = element.end;
  }
  return out + md.slice(position);
}

export function mdxToMarkdown(mdx: string): string {
  return convert(mdx, { count: 0 }).replace(/\n{3,}/g, "\n\n").trim();
}
