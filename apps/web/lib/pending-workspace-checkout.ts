import { browserStorage } from "@/app/_components/browser-storage";

const key = (userId: string, pendingId: string) => `narriflow.checkout-return:${userId}:${pendingId}`;

export function rememberCheckoutWorkspace(userId: string, pendingId: string, previousId: string | null) {
  if (!previousId || previousId === pendingId) return;
  try { browserStorage()?.setItem(key(userId, pendingId), previousId); } catch { /* Storage is optional. */ }
}

export function checkoutReturnWorkspace(
  userId: string, pendingId: string,
  items: ReadonlyArray<{ id: string; isPersonal: boolean; status?: string }>,
): string | null {
  let saved: string | null = null;
  try { saved = browserStorage()?.getItem(key(userId, pendingId)) ?? null; } catch { /* Storage is optional. */ }
  const available = items.filter((item) => item.id !== pendingId && item.status !== "pending_payment");
  return available.find((item) => item.id === saved)?.id ?? available.find((item) => item.isPersonal)?.id ?? available[0]?.id ?? null;
}
