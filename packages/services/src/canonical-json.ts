/** JSON with object keys in code-unit order, so equal values hash and compare equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
