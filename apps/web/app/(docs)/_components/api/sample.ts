import type { SchemaObject } from "@/lib/docs/openapi";

const UUID = "3c90c3cc-0d44-4b50-8888-8dd25736052a";
const DATE_TIME = "2023-11-07T05:31:56Z";

export function primaryType(schema: SchemaObject): string | undefined {
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (type) return type;
  if (schema.properties || schema.additionalProperties) return "object";
  if (schema.items) return "array";
  return undefined;
}

/** Properties in display order: required ones first. */
export function propertiesOf(schema: SchemaObject): Array<[string, SchemaObject]> {
  const entries = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required);
  return [...entries.filter(([name]) => required.has(name)), ...entries.filter(([name]) => !required.has(name))];
}

function sampleNumber(schema: SchemaObject, integer: boolean): number {
  const { minimum, maximum } = schema;
  if (minimum !== undefined && maximum !== undefined) {
    const middle = (minimum + maximum) / 2;
    return integer ? Math.floor(middle) : middle;
  }
  if (minimum !== undefined) return minimum + 1;
  return 123;
}

function sampleString(schema: SchemaObject): string {
  switch (schema.format) {
    case "uuid":
      return UUID;
    case "date-time":
      return DATE_TIME;
    case "date":
      return "2023-11-07";
    default:
      return "<string>";
  }
}

/**
 * An illustrative value for a schema, using fixed placeholders. Arrays get
 * one item, so a request body sample also satisfies `minItems`.
 */
export function sampleValue(schema: SchemaObject): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];

  const variants = schema.oneOf ?? schema.anyOf;
  if (variants?.length) {
    const first = variants.find((variant) => variant.type !== "null") ?? variants[0];
    return first ? sampleValue(first) : null;
  }
  if (schema.allOf?.length) {
    const parts = schema.allOf.map((part) => sampleValue(part));
    return parts.every((part) => part && typeof part === "object") ? Object.assign({}, ...parts) : parts[0];
  }

  switch (primaryType(schema)) {
    case "object":
      return Object.fromEntries(
        propertiesOf(schema).map(([name, property]) => [name, sampleValue(property)]),
      );
    case "array": {
      const items = schema.items ?? {};
      return [sampleValue(items)];
    }
    case "integer":
      return sampleNumber(schema, true);
    case "number":
      return sampleNumber(schema, false);
    case "boolean":
      return true;
    case "null":
      return null;
    case "string":
      return sampleString(schema);
    default:
      return null;
  }
}
