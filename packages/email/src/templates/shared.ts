export interface NotificationEmailTemplate {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function emailShell(input: {
  eyebrow: string;
  heading: string;
  bodyHtml: string;
  actionLabel: string;
  actionUrl: string;
}): string {
  const actionUrl = escapeHtml(input.actionUrl);

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f5f6f8;color:#191b20;font-family:Arial,sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #dfe2e8">
            <tr><td style="height:3px;background:#4f5fff"></td></tr>
            <tr>
              <td style="padding:36px">
                <p style="margin:0 0 12px;color:#4f5fff;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">${escapeHtml(input.eyebrow)}</p>
                <h1 style="margin:0 0 18px;font-size:28px;line-height:1.2">${escapeHtml(input.heading)}</h1>
                <div style="font-size:16px;line-height:1.6;color:#454a55">${input.bodyHtml}</div>
                <p style="margin:28px 0 0">
                  <a href="${actionUrl}" style="display:inline-block;background:#4f5fff;color:#111522;text-decoration:none;font-weight:700;padding:12px 18px">${escapeHtml(input.actionLabel)}</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
