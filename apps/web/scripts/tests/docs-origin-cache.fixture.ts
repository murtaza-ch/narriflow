import { readFileSync } from "node:fs";
import path from "node:path";
import configValue from "../../next.config";

const config = await configValue;
const cacheDirectory = path.resolve(process.argv[2]!);
const base = {
  mode: "production",
  context: process.cwd(),
  target: "node",
  entry: path.resolve("content/docs/api/introduction.mdx"),
  output: { path: path.join(cacheDirectory, "output"), filename: "docs.cjs", library: { type: "commonjs2" } },
  cache: { type: "filesystem", version: "next-test-existing-version", cacheDirectory: path.join(cacheDirectory, "cache"), buildDependencies: { defaultWebpack: [] } },
  optimization: { minimize: false },
  externals: [({ request }: { request: string }, callback: (error: null, result?: string) => void) => callback(null, request.startsWith(".") || path.isAbsolute(request) ? undefined : `commonjs ${request}`)],
};
const webpackConfig = config.webpack!(base, { defaultLoaders: { babel: { loader: "unused-babel-loader" } } } as never);
// Keep the production MDX loader and options from next.config, without Next's
// unrelated JS transforms or application graph. Webpack parses emitted JS itself.
for (const rule of webpackConfig.module.rules) {
  if (Array.isArray(rule.use)) rule.use = rule.use.filter((use: { loader: string }) => use.loader !== "unused-babel-loader").map((use: { loader: string }) => ({ ...use, loader: require.resolve(use.loader) }));
}
const { webpack } = require("next/dist/compiled/webpack/webpack");
const compiler = webpack(webpackConfig);
await new Promise<void>((resolve, reject) => compiler.run((error: Error | null, stats: { hasErrors(): boolean; toString(options: unknown): string; toJson(options: unknown): unknown }) => {
  if (error || stats.hasErrors()) return compiler.close(() => reject(error ?? new Error(stats.toString({ all: false, errors: true }))));
  const json = stats.toJson({ all: false, modules: true, cachedModules: true }) as { modules: { cached?: boolean; name?: string }[] };
  console.log(JSON.stringify({ cacheVersion: webpackConfig.cache.version, cached: json.modules.some((module) => module.cached && module.name?.includes("introduction.mdx")) }));
  compiler.close((closeError: Error | null) => closeError ? reject(closeError) : resolve());
}));
const output = readFileSync(path.join(cacheDirectory, "output/docs.cjs"), "utf8");
const actual = output.match(/href: "(https:[^"]+\/api\/v1\/openapi.json)"/)?.[1];
console.log(JSON.stringify({ href: actual, hasBaseUrl: output.includes(`${process.env.NEXT_PUBLIC_API_URL}/api/v1`) }));
