"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";

export function CalendarLiveRefresh({ delayMs }: { delayMs: number | null }) {
	const router = useRouter();
	const [isRefreshing, startRefresh] = useTransition();

	useEffect(() => {
		if (delayMs === null || isRefreshing) return;
		const timer = window.setTimeout(
			() => startRefresh(() => router.refresh()),
			delayMs,
		);
		return () => window.clearTimeout(timer);
	}, [delayMs, isRefreshing, router]);

	return null;
}
