import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { loginAction } from "../actions";
import styles from "../auth.module.css";

type LoginError = "invalid";

const ERROR_MESSAGES: Record<LoginError, string> = {
  invalid: "Email or password is incorrect.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentUser()) redirect("/");

  const { error } = await searchParams;
  const message = error && error in ERROR_MESSAGES ? ERROR_MESSAGES[error as LoginError] : null;

  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.subtitle}>Welcome back.</p>

        {message ? <div className={styles.error}>{message}</div> : null}

        <form className={styles.form} action={loginAction}>
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
              autoComplete="current-password"
              required
            />
          </div>
          <button className={styles.submit} type="submit">
            Sign in
          </button>
        </form>

        <p className={styles.alt}>
          No account? <Link href="/register">Create one</Link>
        </p>
      </div>
    </div>
  );
}
