import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { requestPasswordResetAction } from "../actions";
import styles from "../auth.module.css";

type ForgotError = "invalid";

const ERROR_MESSAGES: Record<ForgotError, string> = {
  invalid: "That doesn't look like an email address.",
};

// Deliberately says nothing about whether the address is registered — see
// requestPasswordResetAction. "If" is load-bearing.
const SENT_MESSAGE =
  "If that address has an account, a reset link is on its way. " +
  "The link works once and expires in an hour.";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  if (await currentUser()) redirect("/");

  const { error, sent } = await searchParams;
  const message = error && error in ERROR_MESSAGES ? ERROR_MESSAGES[error as ForgotError] : null;

  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        <Image src="/logo.png" alt="" width={40} height={40} className={styles.brand} priority unoptimized />
        <h1 className={styles.title}>Reset password</h1>
        <p className={styles.subtitle}>We&apos;ll mail you a link.</p>

        {message ? <div className={styles.error}>{message}</div> : null}
        {sent ? <div className={styles.notice}>{SENT_MESSAGE}</div> : null}

        <form className={styles.form} action={requestPasswordResetAction}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="email">
              Email
            </label>
            <input
              className={styles.input}
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </div>
          <button className={styles.submit} type="submit">
            Send reset link
          </button>
        </form>

        <p className={styles.alt}>
          Remembered it? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
