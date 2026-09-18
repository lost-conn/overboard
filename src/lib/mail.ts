import "server-only";

// The entire mail capability of this app, which is one transactional message.
//
// Resend's HTTP API is called with plain `fetch` rather than their SDK: the
// request is a single POST with a JSON body, so a dependency would buy nothing
// but a version to keep up with. Nodemailer was the other option and it wants
// an SMTP server, which is the problem this is avoiding.
//
// All network I/O for mail lives here on purpose. Everything underneath —
// minting reset tokens, consuming them, throttling — is then testable against a
// real database without anyone having to stub HTTP.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Fallback from-address. The domain is verified with Resend; the mailbox does
    not exist, which is the point — nothing should reply to it. */
const DEFAULT_MAIL_FROM = "Overboard <overboard@noreply.lostconnection.dev>";

/** Only used when APP_BASE_URL is unset, which in practice means local dev. */
const DEFAULT_BASE_URL = "http://localhost:3000";

/**
 * Origin for absolute links in mail, without a trailing slash.
 *
 * There is nothing already in the tree that knows the public URL — the
 * container is bound to 127.0.0.1 and the hostname lives in the reverse proxy's
 * config, one layer out — so this is its own variable. A request's Host header
 * would be the alternative and it is attacker-controlled, which is exactly the
 * wrong property for the link in a password-reset mail.
 */
export function appBaseUrl(): string {
  const raw = process.env.APP_BASE_URL?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

/**
 * Advisory only. Callers on an enumeration-sensitive path must not let this
 * change what the user sees — "we couldn't mail you" and "there is no account
 * here" have to be indistinguishable from the outside.
 */
export type MailResult = {
  delivered: boolean;
  reason?: string;
};

export async function sendMail(message: MailMessage): Promise<MailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.MAIL_FROM?.trim() || DEFAULT_MAIL_FROM;

  if (!apiKey) {
    return unconfigured(message);
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      // No body in the log: on the reset path it carries the token.
      console.error(
        `[mail] Resend rejected "${message.subject}" with HTTP ${response.status}.`,
      );
      return { delivered: false, reason: `resend-${response.status}` };
    }

    return { delivered: true };
  } catch (error) {
    console.error(
      `[mail] Resend request for "${message.subject}" failed:`,
      error instanceof Error ? error.message : error,
    );
    return { delivered: false, reason: "network" };
  }
}

/** No API key. What that means depends entirely on where we are running. */
function unconfigured(message: MailMessage): MailResult {
  if (process.env.NODE_ENV === "development") {
    // Dev only, and the body is the whole point: it carries the link, so the
    // reset flow is walkable on a laptop with no mail provider behind it.
    console.log(
      [
        "[mail] RESEND_API_KEY is not set — not sending. Message follows.",
        `[mail] to: ${message.to}`,
        `[mail] subject: ${message.subject}`,
        message.text,
      ].join("\n"),
    );
    return { delivered: false, reason: "dev-stdout" };
  }

  if (process.env.NODE_ENV === "production") {
    // Loud, because the failure mode otherwise is a reset form that looks like
    // it worked forever. Subject only — the body carries the token and the
    // server log is not where that belongs.
    console.error(
      `[mail] RESEND_API_KEY is not set. Dropped "${message.subject}". ` +
        "Password reset mail is not being delivered; set the secret " +
        "(jkbase secret set RESEND_API_KEY=...) to fix this.",
    );
    return { delivered: false, reason: "misconfigured" };
  }

  // Tests and anything else: say nothing.
  return { delivered: false, reason: "unconfigured" };
}

export function passwordResetMessage(to: string, resetUrl: string, expiresAt: Date): MailMessage {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));
  return {
    to,
    subject: "Reset your Overboard password",
    text: [
      "Someone asked to reset the password on your Overboard account.",
      "",
      "Open this link to choose a new one:",
      resetUrl,
      "",
      `The link works once and expires in about ${minutes} minutes.`,
      "",
      "If this wasn't you, nothing has changed and you can ignore this mail.",
      "",
      "— The Overboard",
    ].join("\n"),
  };
}
