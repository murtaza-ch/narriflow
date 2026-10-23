import { describe, expect, test } from "bun:test";
import { apiOperations, type SchemaObject } from "@/lib/docs/openapi";
import { sampleValue } from "./sample";

/** The subset of JSON Schema the API's request bodies use. Returns the first violation. */
function violation(schema: SchemaObject, value: unknown, at = "body"): string | undefined {
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants) return variants.some((variant) => !violation(variant, value, at)) ? undefined : `${at} matches no variant`;
  if (schema.enum && !schema.enum.includes(value)) return `${at} is not one of ${schema.enum.join(", ")}`;
  const types = [schema.type ?? []].flat();
  if (value === null) return types.includes("null") || schema.nullable ? undefined : `${at} is null`;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${at} has fewer than ${schema.minItems} items`;
    return value.map((item, index) => violation(schema.items ?? {}, item, `${at}[${index}]`)).find(Boolean);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${at} is shorter than ${schema.minLength}`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${at} is longer than ${schema.maxLength}`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${at} does not match ${schema.pattern}`;
    return undefined;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${at} is below ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${at} is above ${schema.maximum}`;
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const missing = (schema.required ?? []).find((key) => !(key in record));
    if (missing) return `${at}.${missing} is missing`;
    return Object.entries(schema.properties ?? {})
      .filter(([key]) => key in record)
      .map(([key, property]) => violation(property, record[key], `${at}.${key}`))
      .find(Boolean);
  }
  return undefined;
}

describe("API reference request samples", () => {
  const withBodies = apiOperations.filter((operation) => operation.operation.requestBody?.content["application/json"]?.schema);

  test("cover the operations that take a JSON body", () => {
    expect(withBodies.length).toBeGreaterThan(0);
  });

  for (const operation of withBodies) {
    test(`${operation.method.toUpperCase()} ${operation.path} sample satisfies its schema`, () => {
      const schema = operation.operation.requestBody?.content["application/json"]?.schema ?? {};
      expect(violation(schema, sampleValue(schema))).toBeUndefined();
    });
  }
});
