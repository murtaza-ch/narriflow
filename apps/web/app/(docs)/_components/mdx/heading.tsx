import type { ComponentPropsWithoutRef } from "react";
import { Link2 } from "lucide-react";

type Level = "h2" | "h3" | "h4";

/** Section headings with a quiet link that appears on hover or focus; `DocsProse` styles it. */
function createHeading(Tag: Level) {
  return function Heading({ id, children, ...props }: ComponentPropsWithoutRef<Level>) {
    return (
      <Tag id={id} {...props}>
        {children}
        {id ? (
          <a href={`#${id}`} data-anchor="" aria-label="Link to this section">
            <Link2 size={14} aria-hidden="true" />
          </a>
        ) : null}
      </Tag>
    );
  };
}

export const H2 = createHeading("h2");
export const H3 = createHeading("h3");
export const H4 = createHeading("h4");
