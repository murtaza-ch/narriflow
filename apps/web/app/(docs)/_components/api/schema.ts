import type { SchemaObject } from "@/lib/docs/openapi";
import { primaryType, propertiesOf } from "./sample";

export interface Variant {
  schema: SchemaObject;
  /** Variant index in the schema's oneOf/anyOf, for stable ids. */
  index: number;
}

export function nullable(schema: SchemaObject): boolean {
  return Array.isArray(schema.type) && schema.type.includes("null");
}

/** The non-null alternatives of a oneOf/anyOf. */
export function variantsOf(schema: SchemaObject): SchemaObject[] {
  return (schema.oneOf ?? schema.anyOf ?? []).filter((variant) => variant.type !== "null");
}

/** A schema with one real alternative behaves as that alternative. */
export function flatten(schema: SchemaObject): SchemaObject {
  const variants = variantsOf(schema);
  const [only] = variants;
  if (variants.length !== 1 || !only) return schema;
  const { oneOf: _oneOf, anyOf: _anyOf, ...rest } = schema;
  return { ...only, ...rest, description: rest.description ?? only.description };
}

export function isObjectSchema(schema: SchemaObject): boolean {
  return primaryType(schema) === "object" && !!(schema.properties && Object.keys(schema.properties).length);
}

function baseLabel(schema: SchemaObject): string {
  const type = primaryType(schema);
  if (schema.enum) return `enum<${type ?? typeof schema.enum[0]}>`;
  if (type === "array") return `${schema.items ? baseLabel(flatten(schema.items)) : "any"}[]`;
  if (!type) return "any";
  return schema.format && typeof schema.format === "string" ? `${type}<${schema.format}>` : type;
}

/** The type chip text. */
export function typeLabel(input: SchemaObject): string {
  const variants = variantsOf(input);
  if (variants.length > 1) {
    const labels = [...new Set(variants.map((variant) => baseLabel(flatten(variant))))];
    return labels.join(" | ");
  }
  const schema = flatten(input);
  return `${baseLabel(schema)}${nullable(schema) ? " | null" : ""}`;
}

/** Default shown in the chip, or undefined when none is worth showing. */
export function defaultLabel(schema: SchemaObject): string | undefined {
  const value = schema.default;
  if (typeof value === "string") return value === "" ? '""' : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export interface Constraint {
  label: string;
  value: string;
  suffix?: string;
}

export function constraintsOf(schema: SchemaObject): Constraint[] {
  const lines: Constraint[] = [];
  const type = primaryType(schema);
  const { minLength, maxLength, minimum, maximum, minItems, maxItems } = schema;

  if (type === "string") {
    if (minLength !== undefined && maxLength !== undefined) lines.push({ label: "Required string length", value: `${minLength} - ${maxLength}` });
    else if (maxLength !== undefined) lines.push({ label: "Maximum string length", value: String(maxLength) });
    else if (minLength !== undefined) lines.push({ label: "Minimum string length", value: String(minLength) });
  }
  if (type === "integer" || type === "number") {
    if (minimum !== undefined && maximum !== undefined) lines.push({ label: "Required range", value: `${minimum} <= x <= ${maximum}` });
    else if (minimum !== undefined) lines.push({ label: "Required range", value: `x >= ${minimum}` });
    else if (maximum !== undefined) lines.push({ label: "Required range", value: `x <= ${maximum}` });
  }
  if (type === "array") {
    if (minItems !== undefined && maxItems !== undefined) lines.push({ label: "Required array length", value: `${minItems} - ${maxItems}`, suffix: "elements" });
    else if (maxItems !== undefined) lines.push({ label: "Maximum array length", value: String(maxItems) });
    else if (minItems !== undefined) lines.push({ label: "Minimum array length", value: String(minItems) });
  }
  if (schema.pattern) lines.push({ label: "Pattern", value: schema.pattern });
  return lines;
}

/** Enum values the row lists under "Available options". */
export function optionsOf(schema: SchemaObject): unknown[] | undefined {
  if (schema.enum) return schema.enum;
  const items = schema.items ? flatten(schema.items) : undefined;
  return primaryType(schema) === "array" ? items?.enum : undefined;
}

/** `camelCase` and `snake_case` names become kebab-case anchors. */
export function anchor(...parts: string[]): string {
  return parts
    .join("-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export interface ChildRows {
  rows: Array<{ name: string; schema: SchemaObject; required: boolean }>;
  /** Free-form keys, shown as `{key}`. */
  additional?: SchemaObject;
}

export function childrenOf(input: SchemaObject): ChildRows {
  const schema = flatten(input);
  const target = primaryType(schema) === "array" && schema.items ? flatten(schema.items) : schema;
  const required = new Set(target.required);
  const rows = propertiesOf(target).map(([name, child]) => ({ name, schema: child, required: required.has(name) }));
  const extra = target.additionalProperties;
  return { rows, additional: extra && typeof extra === "object" && Object.keys(extra).length ? extra : undefined };
}

export function hasChildren(schema: SchemaObject): boolean {
  const { rows, additional } = childrenOf(schema);
  return rows.length > 0 || additional !== undefined;
}

/** Descriptions print straight quotes as curly ones. */
export function smartQuotes(text: string): string {
  return text
    .replace(/(^|[\s([{])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/(^|[\s([{])'/g, "$1‘")
    .replace(/'/g, "’");
}
