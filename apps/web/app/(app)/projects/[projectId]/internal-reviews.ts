import { useMemo } from "react";
import { createReviewsClient, reviewQueries, reviewMutationOptions, invalidateReviewMutation } from "@narriflow/api-client/reviews";
import type { Intent } from "@narriflow/api-client/core";
import type { CreateReviewRoundInput, InternalReviewCommentInput, InviteReviewersInput } from "@narriflow/validators";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";

type Variant = { id: string; aspectRatio: string; durationSec: number | null };
type CandidateExport = { id: string; editorRevision: number; createdAt: string; variants: Variant[] };
export type ReviewCandidate = { id: string; title: string; editorRevision: number; exports: CandidateExport[] };
type Comment = {
  id: string;
  itemId: string | null;
  parentId: string | null;
  authorKind: string;
  authorName: string;
  body: string;
  timestampSec: number | null;
  resolvedAt: string | null;
  editedAt: string | null;
  createdAt: string;
};
export type ReviewRound = {
  id: string;
  revision: number;
  title: string;
  message: string | null;
  status: string;
  path: string | null;
  allowDownloads: boolean;
  approvalRequired: boolean;
  recipientEmails: string[];
  sentAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  decision: string | null;
  newerWorkAvailable: boolean;
  items: Array<{
    id: string;
    clipId: string;
    clipTitle: string;
    exportId: string;
    editorRevision: number;
    required: boolean;
    currentDecision: string | null;
    variants: Variant[];
  }>;
  comments: Comment[];
  guests: Array<{ id: string; displayName: string | null; email: string | null; firstSeenAt: string; lastSeenAt: string }>;
  auditEvents: Array<{ id: string; kind: string; targetId: string | null; createdAt: string }>;
  notifications: Array<{
    id: string;
    recipientEmail: string;
    kind: string;
    status: string;
    attemptCount: number;
    failureCode: string | null;
    sentAt: string | null;
    createdAt: string;
  }>;
  context: Array<{
    id: string;
    sourceCommentId: string;
    sourceRoundRevision: number;
    authorName: string;
    body: string;
    timestampSec: number | null;
    clipTitle: string | null;
  }>;
};

export type ReviewRoomData = {
  project: { title: string; workspace: { name: string }; approvalRequiredByDefault: boolean };
  candidates: ReviewCandidate[];
  rounds: ReviewRound[];
};

export type ReviewCommand =
  | { kind: "create"; input: CreateReviewRoundInput }
  | { kind: "invite"; roundId: string; input: InviteReviewersInput }
  | { kind: "comment"; roundId: string; input: InternalReviewCommentInput }
  | { kind: "resolve" | "reopen"; roundId: string; commentId: string }
  | { kind: "retry"; roundId: string; ledgerId: string }
  | { kind: "revoke"; roundId: string };

function reviewCommandIdentity(command: ReviewCommand): string {
  if (command.kind === "create") return "create";
  const target = command.kind === "resolve" || command.kind === "reopen" ? command.commentId
    : command.kind === "retry" ? command.ledgerId
    : command.kind === "comment" ? `${command.input.itemId ?? "round"}:${command.input.parentId ?? "root"}` : "";
  return `${command.kind}:${command.roundId}:${target}`;
}

/** Both internal review surfaces share the captured Workspace room and commands. */
export function useInternalReviews(projectId: string, initialData?: ReviewRoomData, enabled = true) {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  const queryClient = useQueryClient();
  const api = useMemo(() => {
    const captured = scope ?? { userId: "", workspaceId: "" };
    return { scope: captured, projectId, client: createReviewsClient(runtime.transport.scoped(captured)), intents: new Map<string, Intent<ReviewCommand>>() };
  }, [runtime, scope, projectId]);
  const roomOptions = reviewQueries.room(api.client, api.scope, api.projectId);
  const room = useQuery<ReviewRoomData>({
    ...roomOptions,
    queryFn: async ({ signal }): Promise<ReviewRoomData> => {
      const value = await roomOptions.queryFn({ signal });
      return {
        ...value,
        candidates: value.candidates.map((candidate) => ({ ...candidate, title: candidate.title ?? "" })),
        rounds: value.rounds.map((round) => ({ ...round, items: round.items.map((item) => ({ ...item, clipTitle: item.clipTitle ?? "" })) })),
      };
    },
    initialData,
    enabled: enabled && scope !== null,
  });
  const mutation = useMutation({
    ...reviewMutationOptions,
    mutationFn: async (command: ReviewCommand) => {
      const root = api.client.projects[":id"]["review-rounds"];
      const param = { id: api.projectId };
      const identity = reviewCommandIdentity(command);
      let intent = api.intents.get(identity);
      if (!intent) { intent = runtime.createIntent<ReviewCommand>(); api.intents.set(identity, intent); }
      const options = { headers: { "Idempotency-Key": intent.keyFor(command) } };
      if (command.kind === "create") return (await root.$post({ param, json: command.input }, options)).json();
      const round = root[":roundId"];
      const roundParam = { ...param, roundId: command.roundId };
      switch (command.kind) {
        case "invite": return (await round.invite.$post({ param: roundParam, json: command.input }, options)).json();
        case "comment": return (await round.comments.$post({ param: roundParam, json: command.input }, options)).json();
        case "resolve": case "reopen": return (await round.comments[":commentId"][command.kind].$post({ param: { ...roundParam, commentId: command.commentId } }, options)).json();
        case "retry": return (await round.notifications.retry.$post({ param: roundParam, json: { ledgerId: command.ledgerId } }, options)).json();
        case "revoke": return (await round.revoke.$post({ param: roundParam }, options)).json();
      }
    },
    onSuccess: async (_result, command) => {
      api.intents.delete(reviewCommandIdentity(command));
      await invalidateReviewMutation(queryClient, api.scope, api.projectId);
    },
  });
  return { room, mutation };
}
