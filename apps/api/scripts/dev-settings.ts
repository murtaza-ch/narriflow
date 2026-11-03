export function serializeDevelopmentSettings(settings: Readonly<Record<string, string>>): string {
  return Object.entries(settings).map(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("Invalid development setting name");
    // Dotenv does not decode JSON's escaped quotes. Preserve the literal value.
    // It also normalizes CR and expands literal \\n/\\r inside double quotes.
    if (!value.includes("\r")) {
      if (!value.includes("'")) return `${name}='${value}'`;
      if (!value.includes('"') && !/\\[nr]/.test(value)) return `${name}="${value}"`;
      if (value.trim() === value && !/^[`'"]|[#\n]/.test(value)) return `${name}=${value}`;
    }
    throw new Error(`Cannot encode development setting ${name} as dotenv`);
  }).join("\n");
}
