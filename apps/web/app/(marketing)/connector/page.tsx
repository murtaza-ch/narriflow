import type { Metadata } from "next";
import Link from "next/link";
import { Box, Code, Heading, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";

export const metadata: Metadata = {
  title: "Narriflow connector for AI assistants",
  description: "Use Narriflow from Claude, ChatGPT, and Codex: turn an original recording into branded clips, export them with subtitles, and hand them to a client for approval.",
};

const SUPPORT_EMAIL = "support@narriflow.com";

const TOOLS: Array<{ group: string; items: string[] }> = [
  { group: "Find your work", items: [
    "List the workspaces you belong to and which can use the connector.",
    "List projects, clips ranked by virality, and your Brand Profiles.",
    "Read one clip's timing, scores, and current edit version.",
    "Read your workspace's remaining credits.",
  ] },
  { group: "Create clips", items: [
    "Submit a supported video link, or upload a file through Narriflow's upload page or command-line helper, choosing a Brand Profile and generation settings.",
    "Generate clips again for a ready project.",
    "Follow exactly the work you started, including which clips succeeded and which failed.",
  ] },
  { group: "Deliver", items: [
    "Export the reviewed edit version in the formats you choose. The result states the resolution and watermark your plan grants.",
    "When you ask for files, get private download links that expire after 15 minutes, plus SRT and VTT subtitles that match the clip.",
    "Prepare a client review: the assistant returns a Narriflow link with the exports selected. You set recipients and send the round yourself.",
    "Check whether the client approved each clip or asked for changes.",
  ] },
  { group: "Publish", items: [
    "List connected social accounts and their publishing options.",
    "Prepare an exact post. Nothing is scheduled until you confirm that exact post in Narriflow or in the assistant's confirmation card.",
    "Inspect scheduled and published posts and recover a failed one.",
    "Create and run RSS Autopilot rules.",
  ] },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack gap="3" layerStyle="band">
      <Heading as="h2" textStyle="title" fontSize="17px">{title}</Heading>
      {children}
    </Stack>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <Text fontSize="14px" color="fg.muted" lineHeight="1.75">{children}</Text>;
}

export default function ConnectorPage() {
  const endpoint = new URL("/mcp", process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").href;
  return (
    <Stack as="main" mx="auto" w="full" maxW="760px" px="6" pt={{ base: "14", md: "20" }} pb="24" gap="10">
      <PageHeader
        title="Narriflow for AI assistants"
        description="Turn an original recording into branded, captioned clips, export them with subtitles, and hand them to a client for approval, from Claude, ChatGPT, or Codex."
      />

      <Stack gap="8">
        <Section title="Who can use it">
          <Body>The connector works with workspaces on an active Pro or Business plan. It acts as you, in any workspace where your current role allows the action, and every change names its workspace explicitly. Processing a video uses that workspace's credits, exactly as it does in Narriflow.</Body>
        </Section>

        <Section title="Connect">
          <Body>Add a custom connector with this address, then sign in to Narriflow and approve the access the assistant asks for. Read access is granted by default; creating clips, exports, Autopilot rules, and posts each need your explicit approval.</Body>
          <Box><Code fontSize="13px" px="2" py="1">{endpoint}</Code></Box>
          <Body>In Claude or ChatGPT, add a custom connector with this address from the connector settings. Codex and Claude Code: run <Code fontSize="12px">codex mcp add narriflow --url {endpoint}</Code> or <Code fontSize="12px">claude mcp add --transport http narriflow {endpoint}</Code>, then log in.</Body>
        </Section>

        <Section title="What the assistant can do">
          <Stack gap="4">
            {TOOLS.map((group) => (
              <Stack key={group.group} gap="1.5">
                <Text fontSize="13px" fontWeight="600">{group.group}</Text>
                <Stack as="ul" gap="1" ps="5" listStyleType="disc">
                  {group.items.map((item) => <Text as="li" key={item} fontSize="14px" color="fg.muted" lineHeight="1.7">{item}</Text>)}
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Section>

        <Section title="Data Narriflow reads and stores">
          <Body>Narriflow reads the projects, clips, exports, Brand Profiles, review rounds, and publishing accounts in your workspaces, and stores the videos you submit or upload and everything generated from them, as it does in the app. Tool results contain product facts and Narriflow links, not transcripts by default. Download links are issued only when you ask for files, expire after 15 minutes, and are not recorded in Narriflow's logs. Narriflow does not receive your conversation with the assistant beyond the tool requests it makes.</Body>
        </Section>

        <Section title="Disconnect">
          <Body>Remove or disconnect Narriflow in your assistant's connector settings, or run <Code fontSize="12px">codex mcp logout narriflow</Code> or <Code fontSize="12px">claude mcp logout narriflow</Code>. Workspace API keys used with the connector can be revoked at any time in Settings, under API. A confirmation link your assistant prepared stops working after ten minutes and never grants more than the connection was allowed.</Body>
        </Section>

        <Section title="Privacy, terms, and support">
          <Body>
            The <Link href="/privacy">privacy policy</Link> and <Link href="/terms">terms</Link> apply to the connector. For help, email <Link href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</Link>.
          </Body>
        </Section>
      </Stack>
    </Stack>
  );
}
