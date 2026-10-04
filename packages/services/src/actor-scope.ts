/** The acting App User and the Workspace whose content they are accessing. */
export type ActorScope = Readonly<{
	actorUserId: string;
	workspaceId: string;
}>;
