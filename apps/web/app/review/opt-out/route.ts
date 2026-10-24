import { reviewerOptOut } from "@narriflow/services";

/** A reviewer's way out of automated review requests. The link in every review email a
 * Standing Grant sends names the Workspace and the address in a signed token, so it needs
 * no login. A GET only asks, because mail scanners follow links; the button posts. */

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex, nofollow",
};

const escapeHtml = (value: string) =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

function page(status: number, heading: string, body: string, action = "") {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(heading)} | Narriflow</title></head>
<body style="margin:0;background:#f5f6f8;color:#191b20;font-family:Arial,sans-serif"><main style="max-width:520px;margin:12vh auto;padding:32px;background:#fff;border-radius:12px">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${escapeHtml(heading)}</h1><p style="margin:0;font-size:16px;line-height:1.6;color:#454a55">${body}</p>${action}</main></body></html>`;
	return new Response(html, { status, headers: HEADERS });
}

const invalid = () => page(404, "This link doesn't work", "It may be incomplete or from a different message. Nothing was changed.");

export async function GET(request: Request) {
	const token = new URL(request.url).searchParams.get("token") ?? "";
	const preview = await reviewerOptOut.preview(token);
	if (!preview) return invalid();
	return page(
		200,
		"Stop automated review requests?",
		`${escapeHtml(preview.workspaceName)} sends clips for review automatically. Choose stop and Narriflow won't send ${escapeHtml(preview.email)} automated review requests from ${escapeHtml(preview.workspaceName)}. Someone there can still invite you to a review by hand.`,
		`<form method="post" action="/review/opt-out" style="margin:24px 0 0"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" style="font:inherit;font-weight:700;padding:12px 18px;border:0;border-radius:8px;background:#191b20;color:#fff;cursor:pointer">Stop automated review requests</button></form>`,
	);
}

export async function POST(request: Request) {
	const form = await request.formData().catch(() => null);
	const token = form?.get("token");
	if (typeof token !== "string") return invalid();
	const done = await reviewerOptOut.confirm(token);
	if (!done) return invalid();
	return page(200, "You're opted out", `${escapeHtml(done.workspaceName)} won't send you automated review requests any more.`);
}
