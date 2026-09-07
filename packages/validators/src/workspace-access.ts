export type WorkspaceAccessRole = "owner" | "admin" | "editor" | "viewer";
export type WorkspaceAccessStatus = "active" | "pending_payment" | "restricted";

export type WorkspaceCapability =
  | "content.view"
  | "content.download"
  | "content.edit"
  | "processing.consume"
  | "publishing.manage"
  | "brand.manage"
  | "social.manage"
  | "workspace.manage"
  | "api.manage"
  | "members.invite"
  | "members.promote_admin"
  | "billing.manage"
  | "review.manage"
  | "review.override";

const ROLE_CAPABILITIES: Record<
  WorkspaceAccessRole,
  ReadonlySet<WorkspaceCapability>
> = {
  owner: new Set([
    "content.view", "content.download", "content.edit", "processing.consume",
    "publishing.manage", "brand.manage", "social.manage", "workspace.manage",
    "api.manage", "members.invite", "members.promote_admin", "billing.manage",
    "review.manage", "review.override",
  ]),
  admin: new Set([
    "content.view", "content.download", "content.edit", "processing.consume",
    "publishing.manage", "brand.manage", "social.manage", "workspace.manage",
    "api.manage", "members.invite",
    "review.manage", "review.override",
  ]),
  editor: new Set([
    "content.view", "content.download", "content.edit", "processing.consume",
    "publishing.manage", "brand.manage", "api.manage",
    "review.manage",
  ]),
  viewer: new Set(["content.view", "content.download"]),
};

const PENDING_OWNER_CAPABILITIES = new Set<WorkspaceCapability>([
  "content.view",
  "content.download",
  "workspace.manage",
  "billing.manage",
]);

const RESTRICTED_OWNER_CAPABILITIES = new Set<WorkspaceCapability>([
  "content.view",
  "content.download",
  "billing.manage",
  "members.invite",
]);

export function roleHasWorkspaceCapability(
  role: WorkspaceAccessRole,
  capability: WorkspaceCapability,
): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

export function workspaceAllowsCapability(
  context: { role: WorkspaceAccessRole; status: WorkspaceAccessStatus },
  capability: WorkspaceCapability,
): boolean {
  if (!roleHasWorkspaceCapability(context.role, capability)) return false;
  if (context.status === "active") return true;
  if (context.role !== "owner") return false;
  return context.status === "pending_payment"
    ? PENDING_OWNER_CAPABILITIES.has(capability)
    : RESTRICTED_OWNER_CAPABILITIES.has(capability);
}
