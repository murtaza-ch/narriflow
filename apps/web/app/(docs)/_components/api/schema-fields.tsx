import type { ReactNode } from "react";
import type { SchemaObject } from "@/lib/docs/openapi";
import { FieldList, FieldRow, Paragraph } from "./fields";
import { primaryType } from "./sample";
import {
  anchor,
  childrenOf,
  constraintsOf,
  defaultLabel,
  flatten,
  hasChildren,
  isObjectSchema,
  nullable,
  optionsOf,
  typeLabel,
  variantsOf,
} from "./schema";
import { VariantTabs } from "./variant-tabs";

interface RowContext {
  /** Anchor prefix such as "body" or "response-404". */
  anchorPrefix: string;
  /** Anchor segments of the parents. */
  trail: string[];
  /** Dotted names of the parents, shown dimmed before the name. */
  path: string[];
}

interface SchemaRowProps extends RowContext {
  name: string;
  schema: SchemaObject;
  required?: boolean;
  /** Overrides the type pills, used by parameters. */
  pills?: string[];
  description?: string;
}

function nestedRows(schema: SchemaObject, context: RowContext, name: string, extraTrail: string[] = []): ReactNode {
  const { rows, additional } = childrenOf(schema);
  const child: RowContext = {
    anchorPrefix: context.anchorPrefix,
    trail: [...context.trail, ...extraTrail],
    path: [...context.path, name],
  };
  return (
    <>
      {rows.map((row) => (
        <SchemaRow key={row.name} {...child} name={row.name} schema={row.schema} required={row.required} />
      ))}
      {additional ? (
        <SchemaRow {...child} trail={[...child.trail, "additional-properties"]} name="{key}" schema={additional} />
      ) : null}
    </>
  );
}

export function SchemaRow({ anchorPrefix, trail, path, name, schema, required, pills, description }: SchemaRowProps) {
  const variants = variantsOf(schema);
  const flat = flatten(schema);
  const segment = name === "{key}" ? "" : name;
  const own = [...trail, nullable(flat) && variants.length < 2 ? `${segment}-one-of-0` : segment];
  const id = anchor(anchorPrefix, ...own);
  const context: RowContext = { anchorPrefix, trail: own, path };

  const text = description ?? flat.description;
  const options = optionsOf(flat);

  let nested: ReactNode;
  let extra: ReactNode;
  if (variants.length > 1) {
    extra = (
      <VariantTabs
        variants={variants.map((variant, index) => ({
          label: `Option ${index + 1}`,
          content: hasChildren(variant) ? nestedRows(variant, context, name, [`one-of-${index}`]) : null,
        }))}
      />
    );
  } else if (hasChildren(flat)) {
    nested = nestedRows(flat, context, name);
  }

  return (
    <FieldRow
      id={id}
      prefix={path.length ? `${path.join(".")}.` : undefined}
      name={name}
      pills={pills ?? [typeLabel(schema)]}
      defaultValue={defaultLabel(flat)}
      required={required}
      deprecated={flat.deprecated}
      description={text ? <Paragraph text={text} /> : undefined}
      constraints={constraintsOf(flat)}
      options={options}
      nested={nested}
      extra={extra}
    />
  );
}

/** The rows of a request or response body: an object's properties, or one row for anything else. */
export function SchemaFields({ schema, anchorPrefix }: { schema: SchemaObject; anchorPrefix: string }) {
  const flat = flatten(schema);
  const root: RowContext = { anchorPrefix, trail: [], path: [] };
  if (isObjectSchema(flat)) {
    const { rows, additional } = childrenOf(flat);
    return (
      <FieldList>
        {rows.map((row) => (
          <SchemaRow key={row.name} {...root} name={row.name} schema={row.schema} required={row.required} />
        ))}
        {additional ? <SchemaRow {...root} name="{key}" schema={additional} /> : null}
      </FieldList>
    );
  }
  return (
    <FieldList>
      <SchemaRow {...root} name={primaryType(flat) === "array" ? "items" : "body"} schema={flat} required />
    </FieldList>
  );
}
