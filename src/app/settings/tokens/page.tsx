import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { listTokens } from "@/lib/tokens";
import {
  consumePendingPlaintext,
  mintTokenAction,
  revokeTokenAction,
} from "@/lib/actions/tokens";
import styles from "./tokens.module.css";

export default async function TokensPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const [tokens, freshlyMinted] = await Promise.all([
    listTokens(session.userId),
    consumePendingPlaintext(session.id),
  ]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>API tokens</h1>
          <p className={styles.subtitle}>
            For MCP and other programmatic access. Each token grants full access to your data.
          </p>
        </div>
        <Link className={styles.back} href="/">
          ← Board
        </Link>
      </header>

      {freshlyMinted ? (
        <div className={styles.flash}>
          <div className={styles.flashLabel}>
            New token <strong>{freshlyMinted.label}</strong> — copy now, it will not be shown again.
          </div>
          <div className={styles.flashValue}>{freshlyMinted.plaintext}</div>
          <div className={styles.flashHint}>
            Stored as a SHA-256 hash. If you lose it, revoke and mint a new one.
          </div>
        </div>
      ) : null}

      <section className={styles.card}>
        <div className={styles.cardTitle}>Create a new token</div>
        <form className={styles.form} action={mintTokenAction}>
          <input
            className={styles.input}
            name="label"
            placeholder="e.g. claude-code-laptop"
            required
            maxLength={80}
          />
          <button className={styles.submit} type="submit">
            Mint
          </button>
        </form>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Existing tokens</div>
        {tokens.length === 0 ? (
          <p className={styles.empty}>No tokens yet.</p>
        ) : (
          <div className={styles.list}>
            {tokens.map((t) => (
              <div className={styles.row} key={t.id}>
                <div>
                  <div
                    className={`${styles.rowLabel}${
                      t.revokedAt ? " " + styles.rowLabelRevoked : ""
                    }`}
                  >
                    {t.label}
                  </div>
                  <div className={styles.rowMeta}>
                    created {formatDate(t.createdAt)}
                    {" · "}
                    {t.lastUsedAt
                      ? `last used ${formatDate(t.lastUsedAt)}`
                      : "never used"}
                    {t.revokedAt ? ` · revoked ${formatDate(t.revokedAt)}` : ""}
                  </div>
                </div>
                <div />
                {t.revokedAt ? (
                  <span className={styles.revokedTag}>revoked</span>
                ) : (
                  <form action={revokeTokenAction.bind(null, t.id)}>
                    <button className={styles.revoke} type="submit">
                      Revoke
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Data backup</div>
        <p className={styles.backupHint}>
          Download all projects, cards, ideas, and tags as a single JSON file.
        </p>
        <a className={styles.submit} href="/api/backup" download>
          Download JSON backup
        </a>
      </section>

      <div className={styles.usage}>
        Use with: <code>claude mcp add overboard --transport http https://&lt;your-host&gt;/api/mcp --header &quot;Authorization: Bearer ob_pat_...&quot;</code>
      </div>
    </main>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
