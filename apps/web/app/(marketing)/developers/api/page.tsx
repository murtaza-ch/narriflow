import type { Metadata } from "next";
import Link from "next/link";
import { Box, Code, Heading, Stack, Table, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";

export const metadata: Metadata = {
  title: "Narriflow API reference",
  description: "Upload a video, generate captioned clips, export them, and download the files over HTTPS, with signed completion callbacks for automation tools.",
};

const ENDPOINTS: Array<[string, string, string]> = [
  ["GET /workspace", "usage:read", "The key's Workspace, plan, and processing minutes"],
  ["GET /brand-profiles", "projects:read", "Brand Profiles to apply at intake"],
  ["POST /uploads", "processing:write", "Open an Upload Session and get signed transfer URLs"],
  ["GET /uploads/{id}", "processing:write", "Read an Upload Session"],
  ["POST /uploads/{id}/grants", "processing:write", "More multipart part URLs"],
  ["POST /uploads/{id}/finalize", "processing:write", "Finish the upload and start its intake"],
  ["DELETE /uploads/{id}", "processing:write", "Discard an unfinished upload"],
  ["POST /projects", "processing:write", "Submit a supported video link"],
  ["GET /projects, GET /projects/{id}", "projects:read", "Projects and their progress"],
  ["POST /projects/{id}/generations", "processing:write", "Generate clips for a ready project"],
  ["GET /projects/{id}/clips, GET /clips/{id}", "projects:read", "Clips ranked by virality"],
  ["POST /clips/{id}/exports", "exports:write", "Export a clip's exact editor revision"],
  ["GET /exports/{id}", "exports:read", "Export progress"],
  ["GET /exports/{id}/download", "exports:read", "Download links (15 minutes) plus SRT and VTT subtitles"],
  ["GET /operations/{id}", "Scope of the work", "Operation Status for an accepted request"],
  ["POST /operations/{id}/callback/redeliver", "Scope of the work", "Send completion callbacks again"],
];

const CURL = `# 1. Open a single-PUT upload
curl -X POST "$NARRIFLOW/api/v1/uploads" \\
  -H "Authorization: Bearer $NARRIFLOW_API_KEY" \\
  -H "Idempotency-Key: talk-2026-10-08:open" \\
  -H "Content-Type: application/json" \\
  -d '{"file":{"name":"talk.mp4","sizeBytes":734003200,"contentType":"video/mp4"},
       "transfer":"single","generation":{"clipCountTarget":8,"clipLengthPreset":"30_to_60s"}}'

# 2. PUT the bytes to upload.transfer.url with upload.transfer.headers
curl -X PUT "$UPLOAD_URL" -H "Content-Type: video/mp4" --upload-file talk.mp4

# 3. Finalize; Narriflow posts to the callback when clips are ready
curl -X POST "$NARRIFLOW/api/v1/uploads/$UPLOAD_ID/finalize" \\
  -H "Authorization: Bearer $NARRIFLOW_API_KEY" -H "Content-Type: application/json" \\
  -d '{"callback":{"url":"https://hooks.example.com/narriflow"}}'

# 4. Export the top clip, then fetch its files
curl -X POST "$NARRIFLOW/api/v1/clips/$CLIP_ID/exports" \\
  -H "Authorization: Bearer $NARRIFLOW_API_KEY" -H "Idempotency-Key: talk-2026-10-08:export:1" \\
  -H "Content-Type: application/json" \\
  -d '{"expectedRevision":0,"aspectRatios":["9:16"],"resolution":"1080p"}'
curl "$NARRIFLOW/api/v1/exports/$EXPORT_ID/download" -H "Authorization: Bearer $NARRIFLOW_API_KEY"`;

const TYPESCRIPT = `const api = (path: string, init: RequestInit = {}) =>
  fetch(\`\${process.env.NARRIFLOW}/api/v1\${path}\`, {
    ...init,
    headers: { authorization: \`Bearer \${process.env.NARRIFLOW_API_KEY}\`, "content-type": "application/json", ...init.headers },
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.message), body);
    return body;
  });

// Submit a link and wait for its clips by polling Operation Status.
const { operation } = await api("/projects", {
  method: "POST",
  headers: { "idempotency-key": "episode-412:submit" },
  body: JSON.stringify({ url: "https://www.youtube.com/watch?v=…", generation: { clipCountTarget: 6 } }),
});
let status = await api(\`/operations/\${operation.operationId}\`);
while (status.state === "working") {
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  status = await api(\`/operations/\${operation.operationId}\`);
}
const { items } = await api(\`/projects/\${status.results.projectId}/clips?limit=3\`);`;

const VERIFY = `import { Webhook } from "standardwebhooks";

const webhook = new Webhook(process.env.NARRIFLOW_CALLBACK_SECRET!); // whsec_…

export async function POST(request: Request) {
  const body = await request.text();
  const event = webhook.verify(body, {
    "webhook-id": request.headers.get("webhook-id")!,
    "webhook-timestamp": request.headers.get("webhook-timestamp")!,
    "webhook-signature": request.headers.get("webhook-signature")!,
  }) as { id: string; data: { operationId: string; state: string } };
  // Delivery is at least once: ignore an event ID you have already handled.
  return new Response(null, { status: 204 });
}`;

const EVENT = `{
  "id": "5b1c…",                       // also the webhook-id header
  "type": "operation.completed",
  "version": 1,
  "createdAt": "2026-10-08T12:00:00.000Z",
  "workspaceId": "…",
  "data": {
    "operationId": "op_…",
    "kind": "intake",                    // intake | generation | export
    "state": "completed",                // completed | partial | failed | cancelled | unavailable
    "projectId": "…",
    "clipIds": ["…"],
    "exportId": "…",                     // exports only
    "failureCode": "…"                   // when not completed
  }
}`;

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <Stack id={id} gap="3" layerStyle="band" scrollMarginTop="20">
      <Heading as="h2" textStyle="title" fontSize="17px">{title}</Heading>
      {children}
    </Stack>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <Text fontSize="14px" color="fg.muted" lineHeight="1.75">{children}</Text>;
}

function Sample({ label, code }: { label: string; code: string }) {
  return (
    <Box as="pre" aria-label={label} maxW="full" fontFamily="mono" fontSize="12px" lineHeight="1.6" p="4" overflowX="auto" layerStyle="well" whiteSpace="pre">
      {code}
    </Box>
  );
}

export default function ApiReferencePage() {
  const base = new URL("/api/v1", process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").href;
  return (
    <Stack as="main" mx="auto" w="full" maxW="820px" minW="0" px="6" pt={{ base: "14", md: "20" }} pb="24" gap="10">
      <PageHeader
        title="Narriflow API"
        description="Upload a video or submit a link, generate captioned clips, export them, and download the files over HTTPS. Automation tools can wait on a signed callback instead of polling."
      />

      <Stack gap="8">
        <Section id="authentication" title="Authentication">
          <Body>Create a Workspace API key in Settings → API and send it as a Bearer token. The key acts only in its own Workspace, with the scopes chosen when it was created, and with its creator's current role. API access requires an active Business plan, and processing uses the Workspace's minutes exactly as it does in Narriflow.</Body>
          <Box><Code fontSize="13px" px="2" py="1">{base}</Code></Box>
          <Body>The OpenAPI 3.1 document is public at <Link href="/api/v1/openapi.json"><Code fontSize="12px">/api/v1/openapi.json</Code></Link>. Import it into an HTTP client or generate a typed client from it. Changes within v1 only add endpoints and optional fields.</Body>
        </Section>

        <Section id="endpoints" title="Endpoints and scopes">
          <Table.ScrollArea borderWidth="0" maxW="full">
          <Table.Root size="sm" variant="line">
            <Table.Header><Table.Row><Table.ColumnHeader>Endpoint</Table.ColumnHeader><Table.ColumnHeader>Scope</Table.ColumnHeader><Table.ColumnHeader>Purpose</Table.ColumnHeader></Table.Row></Table.Header>
            <Table.Body>
              {ENDPOINTS.map(([endpoint, scope, purpose]) => (
                <Table.Row key={endpoint}>
                  <Table.Cell><Code fontSize="12px">{endpoint}</Code></Table.Cell>
                  <Table.Cell fontSize="13px" color="fg.muted">{scope}</Table.Cell>
                  <Table.Cell fontSize="13px" color="fg.muted">{purpose}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
          </Table.ScrollArea>
        </Section>

        <Section id="idempotency" title="Idempotency">
          <Body>Requests that start work (opening an upload, submitting a link, generating, exporting, and redelivering callbacks) need an <Code fontSize="12px">Idempotency-Key</Code> header of 1–200 URL-safe characters. Retry a lost response with the same key and the same body to get the original result, marked <Code fontSize="12px">Idempotent-Replayed: true</Code>. The same key with a different body returns <Code fontSize="12px">409 operation_idempotency_conflict</Code>. Keys belong to the person who created the API key, so a retry after rotating the key, or through the MCP connector, still returns the original result. In loops, build keys from the run, the item, and the action, such as <Code fontSize="12px">run-81:item-3:export</Code>.</Body>
          <Body>Upload grants, finalize, and discard are addressed by Upload Session ID and are safe to repeat without a key.</Body>
        </Section>

        <Section id="errors" title="Errors and rate limits">
          <Body>Errors return a stable <Code fontSize="12px">error</Code> code, a <Code fontSize="12px">message</Code> safe to show, the <Code fontSize="12px">requestId</Code> (also in <Code fontSize="12px">X-Request-Id</Code>), and sometimes <Code fontSize="12px">details</Code> and <Code fontSize="12px">retryAfterSeconds</Code>. Status codes: 400 invalid request, 401 missing or revoked key, 402 the Workspace needs Business, 403 missing scope or role, 404 not found, 409 conflict, 422 unprocessable media, 429 rate limited, 503 temporarily unavailable. Honor <Code fontSize="12px">Retry-After</Code> on 429 and 503.</Body>
          <Body>Each key may send 300 requests a minute. If Narriflow's limiter is briefly unavailable, reads and retries of accepted requests still succeed, while new work returns <Code fontSize="12px">503 mutations_unavailable</Code>.</Body>
        </Section>

        <Section id="uploads" title="Uploads">
          <Body>Open an Upload Session with the file's name, size, and type. With <Code fontSize="12px">"transfer": "single"</Code> you receive one signed PUT URL for any supported size, up to the 5 GiB upload limit, which suits tools that hold a file in memory. With the default <Code fontSize="12px">auto</Code>, files over 100 MiB use resumable multipart parts: PUT each part, keep each response&apos;s ETag, and send the list to finalize. Signed URLs are private; never log or share them. Finalize starts the intake and returns its operation.</Body>
        </Section>

        <Section id="operations" title="Operations">
          <Body>Every accepted request returns an <Code fontSize="12px">operation</Code> with an opaque ID and a status URL. Operation Status reports <Code fontSize="12px">working</Code>, <Code fontSize="12px">completed</Code>, <Code fontSize="12px">partial</Code>, <Code fontSize="12px">failed</Code>, or <Code fontSize="12px">cancelled</Code>, with progress, each clip&apos;s or format&apos;s outcome, and the IDs it produced. An intake follows its upload or import into the clip generation it starts.</Body>
        </Section>

        <Section id="callbacks" title="Completion callbacks">
          <Body>Add <Code fontSize="12px">{'"callback": { "url": "https://…" }'}</Code> to a request that starts an intake, a generation, or an export. The URL must be public HTTPS on port 443. When the operation finishes, Narriflow POSTs one signed <Code fontSize="12px">operation.completed</Code> event. It carries IDs only; call the API for files. A callback URL is part of the request, so retrying with a different URL is a conflict.</Body>
          <Sample label="Callback event" code={EVENT} />
          <Body>Delivery is at least once. Any 2xx response marks the event delivered and 410 stops it. Anything else, including a timeout after 10 seconds, retries after about 30 seconds, 2 minutes, 10 minutes, 30 minutes, 1, 3, 6, 12, and 24 hours, then stops. Redirects are not followed. Use <Code fontSize="12px">POST /operations/{"{id}"}/callback/redeliver</Code> to send it again with the same event ID.</Body>
          <Body>Events follow <Link href="https://www.standardwebhooks.com/">Standard Webhooks</Link>: <Code fontSize="12px">webhook-id</Code>, <Code fontSize="12px">webhook-timestamp</Code>, and <Code fontSize="12px">webhook-signature</Code> headers, signed with HMAC-SHA256 over <Code fontSize="12px">id.timestamp.body</Code>. Create the Workspace&apos;s signing secret in Settings → API before requesting callbacks. After a rotation, events carry signatures from both secrets for 24 hours. Every receiver holding the secret is trusted for the whole Workspace. Reject events with an old timestamp or an event ID you have already handled.</Body>
          <Sample label="Verify a callback in TypeScript" code={VERIFY} />
        </Section>

        <Section id="examples" title="Examples">
          <Body>Upload a file, finalize with a callback, export a clip, and download it:</Body>
          <Sample label="curl example" code={CURL} />
          <Body>Submit a link and poll Operation Status from TypeScript:</Body>
          <Sample label="TypeScript example" code={TYPESCRIPT} />
          <Body>For n8n, start from the <Code fontSize="12px">Drive folder to clips</Code> workflow template in Narriflow&apos;s repository, which uses HTTP Request and Wait nodes with signed callbacks.</Body>
        </Section>
      </Stack>
    </Stack>
  );
}
