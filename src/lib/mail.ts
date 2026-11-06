/**
 * Minimal transactional email over HTTP (Resend). No SDK, no AI. Returns whether it was actually sent,
 * so the caller never claims "we emailed you" when it did not.
 */
export async function sendEmail(p: { to: string; subject: string; text: string }): Promise<{ sent: boolean; reason?: string }> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) return { sent: false, reason: "RESEND_API_KEY and MAIL_FROM are not set" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [p.to], subject: p.subject, text: p.text }),
    });
    if (!res.ok) return { sent: false, reason: `mail provider returned ${res.status}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: (e as Error).message };
  }
}
