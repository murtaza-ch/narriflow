import Link from "next/link";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { CalendarDays, Plus, RefreshCw, X } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Button } from "@narriflow/ui/components/button";
import { ActionSubmitButton } from "@narriflow/ui/components/action-submit-button";
import { Select } from "@narriflow/ui/components/select";
import { workspaceLibraryService, workspaceService } from "@narriflow/services";
import { requireWorkspaceAppUser } from "@/lib/workspace";
import type { SocialPlatform, SocialPostStatus } from "@prisma/client";
import {
  cancelWorkspacePostAction,
  retryWorkspacePostAction,
} from "./actions";

type CalendarView = "month" | "week" | "list";

function calendarWindow(view: CalendarView, value?: string, dateValue?: string) {
  const parsed = value && /^\d{4}-\d{2}$/.test(value) ? new Date(`${value}-01T00:00:00.000Z`) : new Date();
  if (view === "week") {
    const selected = dateValue && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)
      ? new Date(`${dateValue}T00:00:00.000Z`)
      : new Date();
    const from = new Date(Date.UTC(selected.getUTCFullYear(), selected.getUTCMonth(), selected.getUTCDate()));
    const mondayOffset = (from.getUTCDay() + 6) % 7;
    from.setUTCDate(from.getUTCDate() - mondayOffset);
    const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
    return {
      from,
      to,
      label: `${from.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}–${to.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`,
    };
  }
  const from = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1));
  const to = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 1) - 1);
  return { from, to, label: from.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) };
}

function dateKey(value: Date | string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(value))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatInTimezone(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function calendarDays(from: Date, to: Date, padMonth: boolean) {
  const first = new Date(from);
  const last = new Date(to);
  if (padMonth) {
    first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
    last.setUTCDate(last.getUTCDate() + ((7 - ((last.getUTCDay() + 6) % 7) - 1) % 7));
  }
  const days: Date[] = [];
  for (const day = new Date(first); day <= last; day.setUTCDate(day.getUTCDate() + 1)) {
    days.push(new Date(day));
  }
  return days;
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ month?: string; date?: string; view?: string; status?: string; platform?: string; account?: string; project?: string }> }) {
  const appUser = await requireWorkspaceAppUser();
  const params = await searchParams;
  const view: CalendarView = params.view === "week" || params.view === "list" ? params.view : "month";
  const window = calendarWindow(view, params.month, params.date);
  const statuses: SocialPostStatus[] = ["draft", "scheduled", "publishing", "posted", "failed", "cancelled"];
  const platforms: SocialPlatform[] = ["tiktok", "youtube_shorts", "instagram_reels", "linkedin", "x"];
  const status = statuses.includes(params.status as SocialPostStatus) ? params.status as SocialPostStatus : undefined;
  const platform = platforms.includes(params.platform as SocialPlatform) ? params.platform as SocialPlatform : undefined;
  const [posts, workspace, filters] = await Promise.all([
    workspaceLibraryService.listCalendarPosts(appUser.actorUserId, appUser.workspaceId, {
      from: new Date(window.from.getTime() - 36 * 60 * 60 * 1000),
      to: new Date(window.to.getTime() + 36 * 60 * 60 * 1000),
      status,
      platform,
      accountId: params.account,
      projectId: params.project,
    }),
    workspaceService.getWorkspace(appUser.actorUserId, appUser.workspaceId),
    workspaceLibraryService.getCalendarFilters(appUser.actorUserId, appUser.workspaceId),
  ]);
  const timezone = workspace?.timezone ?? "UTC";
  const canPublish =
    appUser.workspace.status === "active" &&
    appUser.workspace.role !== "viewer";
  const canEdit =
    appUser.workspace.role !== "viewer" &&
    (appUser.workspace.status === "active" ||
      appUser.workspace.role === "owner");
  const visiblePosts = posts.filter((post) => {
    if (!post.scheduledFor) return false;
    const key = dateKey(post.scheduledFor, timezone);
    const fromKey = dateKey(window.from, "UTC");
    const toKey = dateKey(window.to, "UTC");
    return key >= fromKey && key <= toKey;
  });
  const days = calendarDays(window.from, window.to, view === "month");
  return (
    <Stack gap="8">
      <PageHeader
        eyebrow="Publishing"
        title="Calendar"
        description={`Scheduled and published workspace posts · ${timezone}`}
        actions={canPublish ? <Button asChild><Link href="/calendar/new"><Plus size={14} />Schedule post</Link></Button> : undefined}
      />
      <Flex align="center" justify="space-between" gap="3">
        <Text textStyle="title" fontSize="18px">{window.label}</Text>
        <Flex gap="1"><Button size="xs" variant={view === "month" ? "outline" : "ghost"} asChild><Link href="/calendar?view=month">Month</Link></Button><Button size="xs" variant={view === "week" ? "outline" : "ghost"} asChild><Link href="/calendar?view=week">Week</Link></Button><Button size="xs" variant={view === "list" ? "outline" : "ghost"} asChild><Link href="/calendar?view=list">List</Link></Button></Flex>
      </Flex>
      <form method="get" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
        <input type="hidden" name="month" value={params.month ?? ""} />
        <input type="hidden" name="view" value={params.view ?? "month"} />
        <Select ariaLabel="Post status" name="status" defaultValue={params.status ?? ""} size="sm" w="150px" items={[{ value: "", label: "All statuses" }, ...statuses.map((value) => ({ value, label: value }))]} />
        <Select ariaLabel="Platform" name="platform" defaultValue={params.platform ?? ""} size="sm" w="170px" items={[{ value: "", label: "All platforms" }, ...platforms.map((value) => ({ value, label: value.replace("_", " ") }))]} />
        <Select ariaLabel="Social account" name="account" defaultValue={params.account ?? ""} size="sm" w="190px" items={[{ value: "", label: "All accounts" }, ...filters.accounts.map((account) => ({ value: account.id, label: account.displayName }))]} />
        <Select ariaLabel="Project" name="project" defaultValue={params.project ?? ""} size="sm" w="220px" items={[{ value: "", label: "All projects" }, ...filters.projects.map((project) => ({ value: project.id, label: project.title }))]} />
        <Button type="submit" size="xs" variant="outline">Apply filters</Button>
      </form>
      {visiblePosts.length === 0 ? (
        <EmptyState icon={<CalendarDays size={22} />} title="Nothing scheduled this month" description="Select a completed workspace clip to plan your next post." />
      ) : view === "list" ? (
        <Stack gap="0" borderTopWidth="1px" borderColor="border">
          {visiblePosts.map((post) => (
            <Flex key={post.id} align={{ base: "flex-start", md: "center" }} direction={{ base: "column", md: "row" }} gap="4" py="4" borderBottomWidth="1px" borderColor="border.subtle">
              <Box w="3px" alignSelf="stretch" bg={post.status === "failed" ? "danger.solid" : post.status === "posted" ? "accent.solid" : "border.emphasized"} />
              <Stack gap="0.5" flex="1" minW="0"><Text fontSize="13px" fontWeight="600" lineClamp={1}>{post.caption}</Text><Text fontSize="11px" color="fg.subtle">{post.project.title} · {post.socialAccount?.displayName ?? "No account selected"}</Text></Stack>
              <Stack gap="0" align={{ md: "flex-end" }}><Text textStyle="eyebrow" color="fg.muted">{post.platform.replace("_", " ")} · {post.status}</Text><Text textStyle="data" fontSize="11px" color="fg.subtle">{post.scheduledFor ? formatInTimezone(post.scheduledFor, timezone) : "Not scheduled"}</Text></Stack>
              {canPublish && post.status === "failed" ? <form action={retryWorkspacePostAction.bind(null, post.id)}><ActionSubmitButton pendingLabel="Retrying…" size="xs" variant="outline"><RefreshCw size={12} />Retry</ActionSubmitButton></form> : null}
              {canEdit && (post.status === "scheduled" || post.status === "draft") ? <form action={cancelWorkspacePostAction.bind(null, post.projectId, post.id)}><ActionSubmitButton pendingLabel="Canceling…" size="xs" variant="ghost"><X size={12} />Cancel</ActionSubmitButton></form> : null}
            </Flex>
          ))}
        </Stack>
      ) : (
        <Box overflowX="auto" borderTopWidth="1px" borderLeftWidth="1px" borderColor="border">
          <Grid templateColumns="repeat(7, minmax(120px, 1fr))" minW="840px">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => <Box key={label} px="3" py="2" borderRightWidth="1px" borderBottomWidth="1px" borderColor="border" textStyle="eyebrow" color="fg.subtle">{label}</Box>)}
            {days.map((day) => {
              const key = dateKey(day, "UTC");
              const dayPosts = visiblePosts.filter((post) => post.scheduledFor && dateKey(post.scheduledFor, timezone) === key);
              const muted = view === "month" && day.getUTCMonth() !== window.from.getUTCMonth();
              return (
                <Stack key={key} gap="2" minH={view === "week" ? "360px" : "126px"} p="2.5" borderRightWidth="1px" borderBottomWidth="1px" borderColor="border" bg={muted ? "bg.subtle" : "bg"}>
                  <Text textStyle="data" fontSize="11px" color={muted ? "fg.subtle" : "fg.muted"}>{day.getUTCDate()}</Text>
                  {dayPosts.map((post) => (
                    <Box key={post.id} p="2" borderLeftWidth="3px" borderColor={post.status === "failed" ? "danger.solid" : post.status === "posted" ? "accent.solid" : "border.emphasized"} bg="bg.subtle">
                      <Text fontSize="11px" fontWeight="600" lineClamp={2}>{post.caption}</Text>
                      <Text mt="1" fontSize="10px" color="fg.subtle">{post.platform.replace("_", " ")} · {post.status}</Text>
                    </Box>
                  ))}
                </Stack>
              );
            })}
          </Grid>
        </Box>
      )}
    </Stack>
  );
}
