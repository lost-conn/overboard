import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { isPasswordResetTokenValid } from "@/lib/password-reset";
import { resetPasswordAction } from "../actions";
import styles from "../auth.module.css";

type ResetError = "invalid" | "mismatch" | "token";

const ERROR_MESSAGES: Record<ResetError, string> = {
  invalid: "Please choose a password at least 8 characters long.",
  mismatch: "Those two passwords don't match.",
  token: "That link is no longer valid. Ask for a new one.",
};

// One message for expired, already-used and never-existed alike. Which of the
// three it was tells the holder of a stolen link something, and tells the
// account's actual owner nothing they can use.
const DEAD_LINK =
  "This reset link is invalid, expired, or has already been used. " +
  "Reset links last an hour and work once.";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  if (await currentUser()) redirect("/");

  const { token, error } = await searchParams;
  const candidate = typeof token === "string" ? token : "";

  // Checked before rendering, so a dead link says so immediately rather than
  // after someone has typed a new password twice into a form that was never
  // going to work. Read-only — the token is consumed by the action, not by
  // being looked at.
  const usable = candidate.length > 0 ? await isPasswordResetTokenValid(candidate) : false;

  const message =
    usable && error && error in ERROR_MESSAGES ? ERROR_MESSAGES[error as ResetError] : null;

  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        <Image src="/logo.png" alt="" width={40} height={40} className={styles.brand} priority unoptimized />
        <h1 className={styles.title}>Choose a new password</h1>
        <p className={styles.subtitle}>This signs you out everywhere else.</p>

        {usable ? (
          <>
            {message ? <div className={styles.error}>{message}</div> : null}

            <form className={styles.form} action={resetPasswordAction}>
              <input type="hidden" name="token" value={candidate} />
              <div className={styles.field}>
                <label className={styles.label} htmlFor="password">
                  New password
                </label>
                <input
                  className={styles.input}
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="confirm">
                  Confirm new password
                </label>
                <input
                  className={styles.input}
                  id="confirm"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              <button className={styles.submit} type="submit">
                Set new password
              </button>
            </form>

            <p className={styles.alt}>
              Changed your mind? <Link href="/login">Sign in</Link>
            </p>
          </>
        ) : (
          <>
            <div className={styles.error}>{DEAD_LINK}</div>
            <p className={styles.alt}>
              <Link href="/forgot">Request a new reset link</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
