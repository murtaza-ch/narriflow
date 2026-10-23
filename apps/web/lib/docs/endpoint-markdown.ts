import { type ApiOperation, apiServers, type SchemaObject, securitySchemes } from "./openapi";

/** An API endpoint's body as Markdown (the title and description come from the caller): request line, auth, parameters, body fields and responses with example JSON. */

const FORMAT_EXAMPLES: Record<string, string> = {
  uuid: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "date-time": "2026-01-01T00:00:00.000Z",
  date: "2026-01-01",
  uri: "https://example.com",
  email: "user@example.com",
};

/** Long enums, like the language list, would drown the table. */
const MAX_ENUM_VALUES = 10;

function typeOf(schema: SchemaObject): string {
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return [...new Set(variants.map(typeOf))].join(" | ");
  if (schema.enum) {
    const values = schema.enum.slice(0, MAX_ENUM_VALUES).map((value) => JSON.stringify(value));
    const more = schema.enum.length - values.length;
    return `${values.join(" | ")}${more > 0 ? ` | … (${more} more)` : ""}`;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type ?? "object"];
  return types
    .map((type) => {
      if (type === "array") return `${schema.items ? typeOf(schema.items) : "any"}[]`;
      return type === "string" && schema.format ? `string (${schema.format})` : type;
    })
    .join(" | ");
}

function exampleOf(schema: SchemaObject, depth = 0): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const variant = variants.find((candidate) => candidate.type !== "null") ?? variants[0];
    return variant ? exampleOf(variant, depth) : null;
  }
  if (schema.enum) return schema.enum[0];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((candidate) => candidate !== "null") ?? "object";
  if (type === "string") return FORMAT_EXAMPLES[schema.format ?? ""] ?? "string";
  if (type === "integer" || type === "number") return schema.minimum ?? 1;
  if (type === "boolean") return true;
  if (type === "array") return depth < 5 && schema.items ? [exampleOf(schema.items, depth + 1)] : [];
  const properties = Object.entries(schema.properties ?? {});
  if (depth >= 5) return {};
  if (properties.length === 0 && typeof schema.additionalProperties === "object") {
    return { key: exampleOf(schema.additionalProperties, depth + 1) };
  }
  return Object.fromEntries(properties.map(([key, property]) => [key, exampleOf(property, depth + 1)]));
}

function json(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function cell(value: string | undefined): string {
  return (value ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
}

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

function describe(schema: SchemaObject): string {
  const fallback = schema.default === undefined ? "" : `Default: \`${JSON.stringify(schema.default)}\`.`;
  const description = schema.description && /[.!?]$/.test(schema.description) ? schema.description : `${schema.description ?? ""}.`;
  return [schema.description && description, fallback].filter(Boolean).join(" ");
}

interface Field {
  name: string;
  schema: SchemaObject;
  required: boolean;
}

/** Object properties flattened to dotted names, three levels deep; arrays of objects read `items[].name`. */
function fieldsOf(schema: SchemaObject, prefix = "", depth = 0): Field[] {
  const properties = { ...schema.properties };
  const required = new Set(schema.required);
  for (const part of schema.allOf ?? []) {
    Object.assign(properties, part.properties);
    for (const name of part.required ?? []) required.add(name);
  }
  return Object.entries(properties).flatMap(([key, property]) => {
    const name = `${prefix}${key}`;
    const field = { name, schema: property, required: required.has(key) };
    const nested = property.items?.properties || property.items?.allOf ? property.items : property;
    const nestedPrefix = nested === property ? `${name}.` : `${name}[].`;
    return depth < 3 ? [field, ...fieldsOf(nested, nestedPrefix, depth + 1)] : [field];
  });
}

function authentication(operation: ApiOperation): string | undefined {
  const schemes = (operation.operation.security ?? []).flatMap((requirement) => Object.keys(requirement));
  const lines = schemes.map((name) => {
    const scheme = securitySchemes[name];
    if (!scheme) return `- ${name}`;
    const how =
      scheme.type === "http" && scheme.scheme === "bearer"
        ? "Send `Authorization: Bearer <token>`."
        : scheme.type === "apiKey"
          ? `Send \`${scheme.name}: <key>\` in the ${scheme.in}.`
          : `${scheme.type} authentication.`;
    return `${how}${scheme.description ? ` ${scheme.description}.` : ""}`;
  });
  return lines.length ? `## Authentication\n\n${lines.join("\n\n")}` : undefined;
}

function parameters({ operation }: ApiOperation): string | undefined {
  if (!operation.parameters?.length) return undefined;
  const rows = operation.parameters.map((parameter) => [
    `\`${parameter.name}\``,
    parameter.in,
    parameter.schema ? typeOf(parameter.schema) : "",
    parameter.required ? "Yes" : "No",
    parameter.description ?? parameter.schema?.description ?? "",
  ]);
  return `## Parameters\n\n${table(["Name", "In", "Type", "Required", "Description"], rows)}`;
}

function requestBody({ operation }: ApiOperation): string | undefined {
  const [contentType, media] = Object.entries(operation.requestBody?.content ?? {})[0] ?? [];
  if (!contentType || !media?.schema) return undefined;
  const fields = fieldsOf(media.schema);
  const intro = `Content type: \`${contentType}\`${operation.requestBody?.required ? " (required)" : ""}`;
  const rows = fields.map(({ name, schema, required }) => [`\`${name}\``, typeOf(schema), required ? "Yes" : "No", describe(schema)]);
  return [
    "## Request body",
    intro,
    rows.length ? table(["Field", "Type", "Required", "Description"], rows) : "",
    json(exampleOf(media.schema)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function responses({ operation }: ApiOperation): string | undefined {
  const entries = Object.entries(operation.responses ?? {});
  if (!entries.length) return undefined;
  const seen = new Map<string, string>();
  const sections = entries.map(([status, response]) => {
    const media = Object.values(response.content ?? {})[0];
    const heading = `### ${status}: ${response.description ?? ""}`.trim();
    if (!media?.schema) return heading;
    const body = JSON.stringify(media.example ?? exampleOf(media.schema), null, 2);
    const earlier = seen.get(body);
    seen.set(body, earlier ?? status);
    return `${heading}\n\n${earlier ? `Same body as ${earlier}.` : `\`\`\`json\n${body}\n\`\`\``}`;
  });
  return `## Responses\n\n${sections.join("\n\n")}`;
}

export function endpointMarkdown(operation: ApiOperation): string {
  const server = apiServers[0]?.url.replace(/\/$/, "") ?? "";
  return [
    `**${operation.method.toUpperCase()}** \`${server}${operation.path}\``,
    authentication(operation),
    parameters(operation),
    requestBody(operation),
    responses(operation),
  ]
    .filter(Boolean)
    .join("\n\n");
}
