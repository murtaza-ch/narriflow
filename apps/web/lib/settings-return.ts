export function isSettingsPath(path: string) {
  return path === "/settings" || path.startsWith("/settings/");
}

export interface SettingsReturnState {
  workspaceId: string;
  destination: string;
}

export function settingsReturnState(
  previous: SettingsReturnState | null,
  workspaceId: string,
  currentUrl: string,
): SettingsReturnState {
  const pathname = currentUrl.split("?")[0] ?? "/home";
  const candidate = isSettingsPath(pathname)
    ? previous?.workspaceId === workspaceId ? previous.destination : "/home"
    : previous && previous.workspaceId !== workspaceId ? "/home" : currentUrl;
  const safe = candidate.startsWith("/") && !candidate.startsWith("//") && !candidate.includes("\\") && !isSettingsPath((candidate.split("?")[0] ?? "/home"));
  return { workspaceId, destination: safe ? candidate : "/home" };
}
