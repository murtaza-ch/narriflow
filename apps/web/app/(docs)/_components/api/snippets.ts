import type { HttpMethod, ParameterObject, SchemaObject } from "@/lib/docs/openapi";
import { sampleValue } from "./sample";

export interface Language {
  id: string;
  label: string;
  /** Shiki grammar. */
  grammar: string;
}

/** The languages the examples offer, in menu order. */
export const LANGUAGES: Language[] = [
  { id: "typescript", label: "TypeScript", grammar: "typescript" },
  { id: "curl", label: "cURL", grammar: "bash" },
  { id: "python", label: "Python", grammar: "python" },
  { id: "javascript", label: "JavaScript", grammar: "javascript" },
  { id: "php", label: "PHP", grammar: "php" },
  { id: "go", label: "Go", grammar: "go" },
  { id: "java", label: "Java", grammar: "java" },
  { id: "ruby", label: "Ruby", grammar: "ruby" },
];

export interface RequestInputs {
  /** The token without its scheme prefix, printed as given: callers pass a masked one for display. */
  token?: string;
  headers?: Record<string, string>;
  path?: Record<string, string>;
  query?: Record<string, string>;
  /** Replaces the generated example body. */
  body?: unknown;
}

export interface RequestModel {
  method: string;
  url: string;
  /** In display order for most languages; cURL and PHP sort them. */
  headers: Array<[string, string]>;
  body?: unknown;
  /** The header that carries the credential and its scheme, so examples can read the key from the environment. */
  credential?: { header: string; prefix?: string };
  responseType?: string;
}

export interface AuthInfo {
  /** Header or query key the credential travels in. */
  name: string;
  in: "header" | "query" | "cookie";
  /** "Bearer" and "Basic" go before the token. */
  prefix?: string;
  description?: string;
}

/** What a request needs from an operation; plain data, so the playground can use it in the browser. */
export interface RequestSpec {
  method: HttpMethod;
  path: string;
  origin: string;
  auth?: AuthInfo;
  /** Header parameters other than the credential. */
  headers: ParameterObject[];
  pathParams: ParameterObject[];
  queryParams: ParameterObject[];
  bodySchema?: SchemaObject;
  contentType?: string;
  /** Readable name of the success response's type, for the TypeScript example. */
  responseType?: string;
}

export function sampleBody(spec: RequestSpec): unknown {
  return spec.bodySchema ? sampleValue(spec.bodySchema) : undefined;
}

/**
 * The request as the page shows it: placeholders stand in for anything not entered.
 * With `literal`, only entered values are kept, which is what "Send" transmits.
 */
export function buildRequest(spec: RequestSpec, inputs: RequestInputs = {}, literal = false): RequestModel {
  const placeholder = (name: string) => (literal ? "" : `<${name}>`);
  const headers: Array<[string, string]> = spec.headers.flatMap((parameter): Array<[string, string]> => {
    const value = inputs.headers?.[parameter.name] || placeholder(parameter.name);
    return value ? [[parameter.name, value]] : [];
  });
  const token = inputs.token || placeholder("token");
  let credential: RequestModel["credential"];
  if (spec.auth?.in === "header" && token) {
    credential = { header: spec.auth.name, prefix: spec.auth.prefix };
    headers.push([spec.auth.name, spec.auth.prefix ? `${spec.auth.prefix} ${token}` : token]);
  }

  const hasBody = spec.contentType !== undefined;
  const body = !hasBody ? undefined : inputs.body !== undefined || literal ? inputs.body : sampleBody(spec);
  if (hasBody && body !== undefined) headers.push(["Content-Type", spec.contentType as string]);

  const query = spec.queryParams.flatMap((parameter): string[] => {
    const fallback = parameter.schema?.default;
    const value = inputs.query?.[parameter.name] || (!literal && fallback !== undefined && fallback !== null ? String(fallback) : "");
    if (value) return [`${encodeURIComponent(parameter.name)}=${encodeURIComponent(value)}`];
    return parameter.required && !literal ? [`${encodeURIComponent(parameter.name)}=<${parameter.name}>`] : [];
  });
  if (spec.auth?.in === "query" && token) query.push(`${encodeURIComponent(spec.auth.name)}=${encodeURIComponent(token)}`);

  const path = spec.path.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const value = inputs.path?.[name];
    return value ? encodeURIComponent(value) : match;
  });
  return {
    method: spec.method.toUpperCase(),
    url: `${spec.origin}${path}${query.length ? `?${query.join("&")}` : ""}`,
    headers,
    body,
    credential,
    responseType: spec.responseType,
  };
}

const byName = (a: [string, string], b: [string, string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// --- JavaScript: objects print inline up to 80 characters.

const INLINE_LIMIT = 80;
const IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;

function jsString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

function jsBlock(open: string, close: string, items: string[], pad: string): string {
  const inline = `${open}${items.join(", ")}${close}`;
  if (inline.length <= INLINE_LIMIT && !inline.includes("\n")) return inline;
  return `${open}\n${items.map((item) => `${pad}  ${item}`).join(",\n")}\n${pad}${close}`;
}

function jsLiteral(value: unknown, pad = ""): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return jsString(value);
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return jsBlock("[", "]", value.map((item) => jsLiteral(item, `${pad}  `)), pad);
  }
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  return jsBlock(
    "{",
    "}",
    entries.map(([key, item]) => `${IDENTIFIER.test(key) ? key : jsString(key)}: ${jsLiteral(item, `${pad}  `)}`),
    pad,
  );
}

function javascript(request: RequestModel): string {
  const entries = [
    `method: ${jsString(request.method)}`,
    `headers: ${jsLiteral(Object.fromEntries(request.headers), "  ")}`,
  ];
  if (request.body !== undefined) entries.push(`body: JSON.stringify(${jsLiteral(request.body, "  ")})`);
  return [
    `const options = ${jsBlock("{", "}", entries, "")};`,
    "",
    `fetch(${jsString(request.url)}, options)`,
    "  .then(res => res.json())",
    "  .then(res => console.log(res))",
    "  .catch(err => console.error(err));",
  ].join("\n");
}

// --- TypeScript: typed fetch, with the key read from the environment and never printed.

const API_KEY_ENV = "process.env.NARRIFLOW_API_KEY";

function tsKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/** Objects always break one property per line, with trailing commas; short lists of primitives stay inline. */
function tsLiteral(value: unknown, indent: string): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (value.every((item) => item === null || typeof item !== "object")) return `[${value.map((item) => tsLiteral(item, inner)).join(", ")}]`;
    return `[\n${value.map((item) => `${inner}${tsLiteral(item, inner)},`).join("\n")}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  return `{\n${entries.map(([key, item]) => `${inner}${tsKey(key)}: ${tsLiteral(item, inner)},`).join("\n")}\n${indent}}`;
}

function typescript(request: RequestModel): string {
  const header = (name: string, value: string): string => {
    if (request.credential?.header === name) {
      const prefix = request.credential.prefix ? `${request.credential.prefix} ` : "";
      return `${tsKey(name)}: \`${prefix}\${${API_KEY_ENV}}\``;
    }
    if (name.toLowerCase() === "idempotency-key") {
      // A key the caller hasn't set is generated per call, as the API expects.
      return `"Idempotency-Key": ${/^<.*>$/.test(value) ? "crypto.randomUUID()" : JSON.stringify(value)}`;
    }
    return `${tsKey(name)}: ${JSON.stringify(value)}`;
  };

  // Credential, content type, then the request's own headers.
  const rank = ([name]: [string, string]) => (name === request.credential?.header ? 0 : name === "Content-Type" ? 1 : 2);
  const headers = [...request.headers].sort((a, b) => rank(a) - rank(b));

  const options = [`  method: ${JSON.stringify(request.method)},`];
  if (headers.length) options.push("  headers: {", ...headers.map(([name, value]) => `    ${header(name, value)},`), "  },");
  if (request.body !== undefined) options.push(`  body: JSON.stringify(${tsLiteral(request.body, "  ")}),`);

  return [
    `const response = await fetch(${JSON.stringify(request.url)}, {`,
    ...options,
    "});",
    "",
    `if (!response.ok) throw new Error(\`Request failed with \${response.status}\`);`,
    "",
    // Name the success body for the reader without inventing an undeclared type.
    ...(request.responseType ? [`// The body is a ${request.responseType}; its fields are listed under Response.`] : []),
    "const data = await response.json();",
  ].join("\n");
}

// --- Python and PHP: literal printers that break an object once it has several keys.

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(kind: "object" | "array", values: string[], breakLines: boolean, level: number): string {
  const indent = "    ";
  const [open, close] = kind === "object" ? ["{", "}"] : ["[", "]"];
  if (!values.length) return `${open}${close}`;
  if (!breakLines) return kind === "object" ? `{ ${values.join(", ")} }` : `[${values.join(", ")}]`;
  const inner = indent.repeat(level);
  return `${open}\n${inner}${values.join(`,\n${inner}`)}\n${indent.repeat(level - 1)}${close}`;
}

function pythonLiteral(value: unknown, level = 1): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    const breakLines = value.some((item) => isObject(item) && Object.keys(item).length > 1);
    return join("array", value.map((item) => pythonLiteral(item, level + 1)), breakLines, level);
  }
  const entries = Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonLiteral(item, level + 1)}`);
  return join("object", entries, entries.length > 1, level);
}

function phpLiteral(value: unknown, level = 1): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (typeof value !== "object") return String(value);
  const items = Array.isArray(value)
    ? value.map((item) => phpLiteral(item, level + 1))
    : Object.entries(value).map(([key, item]) => `'${key}' => ${phpLiteral(item, level + 1)}`);
  const indent = "    ";
  const inner = indent.repeat(level);
  return `[\n${inner}${items.join(`,\n${inner}`)}\n${indent.repeat(level - 1)}]`;
}

// --- One printer per language.

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function curl(request: RequestModel): string {
  const url = /[?&'" ]/.test(request.url) ? shellQuote(request.url) : request.url;
  const parts = [`--request ${request.method}`, `--url ${url}`];
  for (const [name, value] of [...request.headers].sort(byName)) parts.push(`--header ${shellQuote(`${name}: ${value}`)}`);
  if (request.body !== undefined) {
    const json = pretty(request.body);
    parts.push(json.split("\n").length > 3 ? `--data '\n${json}\n'` : `--data '${json}'`);
  }
  return `curl ${parts.join(" \\\n  ")}`;
}

function python(request: RequestModel): string {
  const hasBody = request.body !== undefined;
  const hasHeaders = request.headers.length > 0;
  const lines = ["import requests", "", `url = ${JSON.stringify(request.url)}`, ""];
  if (hasBody) lines.push(`payload = ${pythonLiteral(request.body)}`);
  if (hasHeaders) {
    const entries = request.headers.map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`);
    lines.push(
      entries.length === 1 ? `headers = {${entries[0]}}` : `headers = {\n${entries.map((entry) => `    ${entry}`).join(",\n")}\n}`,
    );
  }
  if (hasBody || hasHeaders) lines.push("");
  const args = ["url", ...(hasBody ? ["json=payload"] : []), ...(hasHeaders ? ["headers=headers"] : [])];
  lines.push(`response = requests.${request.method.toLowerCase()}(${args.join(", ")})`, "", "print(response.text)");
  return lines.join("\n");
}

function php(request: RequestModel): string {
  const options = [
    `  CURLOPT_URL => ${JSON.stringify(request.url)},`,
    "  CURLOPT_RETURNTRANSFER => true,",
    '  CURLOPT_ENCODING => "",',
    "  CURLOPT_MAXREDIRS => 10,",
    "  CURLOPT_TIMEOUT => 30,",
    "  CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,",
    `  CURLOPT_CUSTOMREQUEST => ${JSON.stringify(request.method)},`,
  ];
  if (request.body !== undefined) {
    options.push(`  CURLOPT_POSTFIELDS => json_encode(${phpLiteral(request.body).replace(/\n\]$/, "\n  ]")}),`);
  }
  if (request.headers.length) {
    const headers = [...request.headers].sort(byName).map(([name, value]) => `    ${JSON.stringify(`${name}: ${value}`)}`);
    options.push(`  CURLOPT_HTTPHEADER => [\n${headers.join(",\n")}\n  ],`);
  }
  return [
    "<?php",
    "",
    "$curl = curl_init();",
    "",
    "curl_setopt_array($curl, [",
    ...options,
    "]);",
    "",
    "$response = curl_exec($curl);",
    "$err = curl_error($curl);",
    "",
    "curl_close($curl);",
    "",
    "if ($err) {",
    '  echo "cURL Error #:" . $err;',
    "} else {",
    "  echo $response;",
    "}",
  ].join("\n");
}

function go(request: RequestModel): string {
  const hasBody = request.body !== undefined;
  const lines = [
    "package main",
    "",
    "import (",
    '\t"fmt"',
    ...(hasBody ? ['\t"strings"'] : []),
    '\t"net/http"',
    '\t"io"',
    ")",
    "",
    "func main() {",
    "",
    `\turl := ${JSON.stringify(request.url)}`,
    "",
  ];
  if (hasBody) lines.push(`\tpayload := strings.NewReader(${JSON.stringify(pretty(request.body))})`, "");
  lines.push(`\treq, _ := http.NewRequest(${JSON.stringify(request.method)}, url, ${hasBody ? "payload" : "nil"})`, "");
  if (request.headers.length) {
    for (const [name, value] of request.headers) lines.push(`\treq.Header.Add(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
    lines.push("");
  }
  lines.push(
    "\tres, _ := http.DefaultClient.Do(req)",
    "",
    "\tdefer res.Body.Close()",
    "\tbody, _ := io.ReadAll(res.Body)",
    "",
    "\tfmt.Println(string(body))",
    "",
    "}",
  );
  return lines.join("\n");
}

function java(request: RequestModel): string {
  const lines = [`HttpResponse<String> response = Unirest.${request.method.toLowerCase()}(${JSON.stringify(request.url)})`];
  for (const [name, value] of request.headers) lines.push(`  .header(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
  if (request.body !== undefined) lines.push(`  .body(${JSON.stringify(pretty(request.body))})`);
  lines.push("  .asString();");
  return lines.join("\n");
}

function ruby(request: RequestModel): string {
  const method = request.method[0] + request.method.slice(1).toLowerCase();
  const lines = [
    "require 'uri'",
    "require 'net/http'",
    "",
    `url = URI(${JSON.stringify(request.url)})`,
    "",
    "http = Net::HTTP.new(url.host, url.port)",
    "http.use_ssl = true",
    "",
    `request = Net::HTTP::${method}.new(url)`,
  ];
  for (const [name, value] of request.headers) lines.push(`request[${JSON.stringify(name)}] = ${jsString(value)}`);
  if (request.body !== undefined) lines.push(`request.body = ${JSON.stringify(pretty(request.body))}`);
  lines.push("", "response = http.request(request)", "puts response.read_body");
  return lines.join("\n");
}

const PRINTERS: Record<string, (request: RequestModel) => string> = { typescript, curl, python, javascript, php, go, java, ruby };

export function generateSnippet(languageId: string, request: RequestModel): string {
  return (PRINTERS[languageId] ?? curl)(request);
}
