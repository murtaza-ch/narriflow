import { Box } from "@chakra-ui/react";
import { CodeBlock } from "@narriflow/ui/components/code-block";

/** A first request that works with any key: read the key's own workspace. */
export function ApiQuickstart({ apiBase }: { apiBase: string }) {
  const url = `${apiBase}/workspace`;
  return (
    <Box>
      <CodeBlock
        copyLabel="Copy snippet"
        tabs={[
          {
            label: "cURL",
            language: "shell",
            code: `curl ${url} \\\n  -H "Authorization: Bearer $NARRIFLOW_API_KEY"`,
          },
          {
            label: "JavaScript",
            language: "javascript",
            code: `const response = await fetch("${url}", {\n  headers: { Authorization: \`Bearer \${process.env.NARRIFLOW_API_KEY}\` },\n});\nconsole.log(await response.json());`,
          },
          {
            label: "Python",
            language: "python",
            code: `import os, requests\n\nresponse = requests.get(\n    "${url}",\n    headers={"Authorization": f"Bearer {os.environ['NARRIFLOW_API_KEY']}"},\n)\nprint(response.json())`,
          },
        ]}
      />
    </Box>
  );
}
