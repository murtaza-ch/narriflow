export const PROJECT_TABS = [
	"clips",
	"transcript",
	"repurpose",
	"dubbing",
	"review",
	"posts",
	"analytics",
	"activity",
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

export function projectTabFromSearchParam(
	value: string | null | undefined,
): ProjectTab {
	return value && (PROJECT_TABS as readonly string[]).includes(value)
		? (value as ProjectTab)
		: "clips";
}
