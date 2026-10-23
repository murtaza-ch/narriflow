import { type ApiOperation, apiServers, type ParameterObject, securitySchemes } from "@/lib/docs/openapi";
import type { AuthInfo, RequestSpec } from "./snippets";

export function apiOrigin(): string {
  return (apiServers[0]?.url ?? "").replace(/\/$/, "");
}

export function authOf(operation: ApiOperation): AuthInfo | undefined {
  const requirement = operation.operation.security?.[0];
  const scheme = requirement ? Object.keys(requirement)[0] : undefined;
  const definition = scheme ? securitySchemes[scheme] : undefined;
  if (!definition) return undefined;
  if (definition.type === "http") {
    const basic = definition.scheme?.toLowerCase() === "basic";
    return { name: "Authorization", in: "header", prefix: basic ? "Basic" : "Bearer", description: definition.description };
  }
  if (definition.type === "apiKey" && definition.name) {
    return { name: definition.name, in: (definition.in as AuthInfo["in"]) ?? "header", description: definition.description };
  }
  return undefined;
}

function parametersIn(operation: ApiOperation, location: ParameterObject["in"]): ParameterObject[] {
  return (operation.operation.parameters ?? []).filter((parameter) => parameter.in === location);
}

/** A readable TypeScript name for the success response: its title, else the component it was referenced by. */
function responseTypeOf(operation: ApiOperation): string | undefined {
  const responses = operation.operation.responses ?? {};
  const success = Object.keys(responses).find((code) => code.startsWith("2"));
  const content = success ? responses[success]?.content : undefined;
  const schema = content?.["application/json"]?.schema;
  const name = (schema?.title ?? schema?.refName)?.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) => next?.toUpperCase() ?? "");
  return name && /^[A-Za-z]/.test(name) ? name[0]?.toUpperCase() + name.slice(1) : undefined;
}

export function specOf(operation: ApiOperation): RequestSpec {
  const auth = authOf(operation);
  const contentType = Object.keys(operation.operation.requestBody?.content ?? {})[0];
  return {
    method: operation.method,
    path: operation.path,
    origin: apiOrigin(),
    auth,
    headers: parametersIn(operation, "header").filter(
      (parameter) => !(auth?.in === "header" && parameter.name.toLowerCase() === auth.name.toLowerCase()),
    ),
    pathParams: parametersIn(operation, "path"),
    queryParams: parametersIn(operation, "query"),
    bodySchema: contentType ? operation.operation.requestBody?.content[contentType]?.schema : undefined,
    contentType,
    responseType: responseTypeOf(operation),
  };
}
