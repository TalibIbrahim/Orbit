import nodemailer from "nodemailer";
import { errMsg } from "./agents";
import { getSettings } from "./settings";

export const COLORS = { info: 0x3b82f6, warning: 0xf59e0b, critical: 0xef4444, ok: 0x22c55e } as const;

/** Send a notification via Discord and/or email. ok=true when at least one channel delivered (or none configured -> error). */
export async function notify(title: string, description: string, color: number = COLORS.warning): Promise<{ ok: boolean; error?: string }> {
  const s = getSettings();
  const errors: string[] = [];
  let sent = 0;

  if (s.discordWebhookUrl) {
    try {
      const res = await fetch(s.discordWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embeds: [{ title: title.slice(0, 250), description: description.slice(0, 3900), color }] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Discord answered ${res.status}`);
      sent++;
    } catch (e) {
      errors.push(`discord: ${errMsg(e)}`);
    }
  }

  const m = s.email;
  if (m?.enabled && m.smtpHost && m.to) {
    try {
      const transport = nodemailer.createTransport({
        host: m.smtpHost,
        port: m.smtpPort,
        secure: m.secure,
        auth: m.user ? { user: m.user, pass: m.password ?? "" } : undefined,
        connectionTimeout: 10_000,
        socketTimeout: 15_000,
      });
      await transport.sendMail({ from: m.from || m.user, to: m.to, subject: `[Orbit] ${title}`, text: description });
      sent++;
    } catch (e) {
      errors.push(`email: ${errMsg(e)}`);
    }
  }

  if (!sent && !errors.length) errors.push("no notification channel configured");
  return sent > 0 ? { ok: true, ...(errors.length ? { error: errors.join("; ") } : {}) } : { ok: false, error: errors.join("; ") };
}
