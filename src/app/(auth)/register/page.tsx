import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { registerAction } from "../actions";
import styles from "../auth.module.css";

type RegisterError = "invalid" | "taken";

const ERROR_MESSAGES: Record<RegisterError, string> = {
  invalid: "Please provide a valid email and a password at least 8 characters long.",
  taken: "An account with that email already exists.",
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentUser()) redirect("/");

  const { error } = await searchParams;
  const message =
    error && error in ERROR_MESSAGES ? ERROR_MESSAGES[error as RegisterError] : null;

  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        <h1 className={styles.title}>Create account</h1>
        <p className={styles.subtitle}>Your projects, only yours.</p>

        {message ? <div className={styles.error}>{message}</div> : null}

        <form className={styles.form} action={registerAction}>
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
          <div className={styles.field}>
            <label className={styles.label} htmlFor="password">
              Password
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
          <button className={styles.submit} type="submit">
            Create account
          </button>
        </form>

        <p className={styles.alt}>
          Already have one? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
