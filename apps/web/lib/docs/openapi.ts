import { publicOpenApiDocument } from "@/lib/rest-api/public-openapi";

/**
 * The REST API reference, read from the document the API itself serves.
 * Local `$ref`s are resolved once so pages render plain schema objects.
 */

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface SchemaObject {
  /** The component name this schema was referenced by (`UploadResult`), kept when `$ref`s are resolved. */
  refName?: string;
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
  nullable?: boolean;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  required?: string[];
  properties?: Record<string, SchemaObject>;
  additionalProperties?: boolean | SchemaObject;
  items?: SchemaObject;
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
}

export interface ParameterObject {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: SchemaObject;
  example?: unknown;
}

export interface MediaTypeObject {
  schema?: SchemaObject;
  example?: unknown;
  examples?: Record<string, { summary?: string; value?: unknown }>;
}

export interface RequestBodyObject {
  description?: string;
  required?: boolean;
  content: Record<string, MediaTypeObject>;
}

export interface ResponseObject {
  description?: string;
  headers?: Record<string, { description?: string; schema?: SchemaObject }>;
  content?: Record<string, MediaTypeObject>;
}

export interface SecuritySchemeObject {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  name?: string;
  in?: string;
  description?: string;
}

export interface OperationObject {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  security?: Array<Record<string, string[]>>;
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
}

export interface ApiOperation {
  method: HttpMethod;
  path: string;
  title: string;
  description?: string;
  tag: string;
  href: string;
  operation: OperationObject;
}

interface OpenApiDocument {
  servers?: Array<{ url: string; description?: string }>;
  components?: {
    securitySchemes?: Record<string, SecuritySchemeObject>;
    schemas?: Record<string, SchemaObject>;
  };
  security?: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, unknown>>;
}

const document = publicOpenApiDocument() as unknown as OpenApiDocument;

const SCHEMA_REF_PREFIX = "#/components/schemas/";

function resolveRefs<T>(value: T, seen: Set<string> = new Set()): T {
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, seen)) as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const ref = record.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    // A cycle keeps its reference instead of recursing forever.
    if (seen.has(ref)) return value;
    const target = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], document);
    const { $ref: _ref, ...siblings } = record;
    const refName = ref.startsWith(SCHEMA_REF_PREFIX) ? ref.slice(SCHEMA_REF_PREFIX.length) : undefined;
    return resolveRefs({ ...(target as object), ...siblings, ...(refName ? { refName } : {}) }, new Set([...seen, ref])) as T;
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, resolveRefs(item, seen)])) as T;
}

/** URL slug the way Mintlify builds it: lowercase words joined by hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const apiServers = document.servers ?? [];
export const securitySchemes = resolveRefs(document.components?.securitySchemes ?? {});

export const apiOperations: ApiOperation[] = Object.entries(document.paths).flatMap(([path, item]) =>
  HTTP_METHODS.flatMap((method) => {
    const raw = item[method];
    if (!raw) return [];
    const operation = resolveRefs(raw as OperationObject);
    const title = operation.summary ?? `${method.toUpperCase()} ${path}`;
    const tag = operation.tags?.[0] ?? "Endpoints";
    return [
      {
        method,
        path,
        title,
        description: operation.description,
        tag,
        href: `/docs/api-reference/${slugify(tag)}/${slugify(title)}`,
        operation: { ...operation, security: operation.security ?? document.security },
      },
    ];
  }),
);

const seen = new Set<string>();
for (const { href, method, path } of apiOperations) {
  if (seen.has(href)) throw new Error(`Two API operations share the docs URL ${href} (${method.toUpperCase()} ${path}); give one a distinct summary.`);
  seen.add(href);
}

export function findOperation(href: string): ApiOperation | undefined {
  return apiOperations.find((operation) => operation.href === href);
}
