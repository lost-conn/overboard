"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { shareProjectAction, unshareProjectAction, listSharesAction } from "@/lib/actions/sharing";
import styles from "./ShareDialog.module.css";

type ShareEntry = {
  userId: string;
  email: string;
  pinnedToBoard: boolean;
  createdAt: Date;
};

type Props = {
  projectId: string | null;
  onClose: () => void;
};

export function ShareDialog({ projectId, onClose }: Props) {
  const open = projectId !== null;
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!projectId) return;
    setEmail("");
    setError(null);
    listSharesAction(projectId).then(setShares).catch(() => setShares([]));
  }, [projectId]);

  const handleShare = () => {
    if (!projectId || !email.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await shareProjectAction({ projectId, email: email.trim() });
      if (!result.ok) {
        setError(result.error ?? "Failed to share");
        return;
      }
      setEmail("");
      const updated = await listSharesAction(projectId);
      setShares(updated);
    });
  };

  const handleUnshare = (targetUserId: string) => {
    if (!projectId) return;
    startTransition(async () => {
      await unshareProjectAction({ projectId, userId: targetUserId });
      const updated = await listSharesAction(projectId);
      setShares(updated);
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>Share project</Dialog.Title>
            <Dialog.Close className={styles.closeBtn} aria-label="Close">
              <X size={16} aria-hidden />
            </Dialog.Close>
          </div>

          <div className={styles.body}>
            <form
              className={styles.shareForm}
              onSubmit={(e) => { e.preventDefault(); handleShare(); }}
            >
              <input
                className={styles.emailInput}
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(null); }}
                disabled={isPending}
                autoFocus
              />
              <button
                type="submit"
                className={styles.shareBtn}
                disabled={isPending || !email.trim()}
              >
                Share
              </button>
            </form>
            {error ? <p className={styles.error}>{error}</p> : null}

            {shares.length > 0 ? (
              <div className={styles.shareList}>
                <p className={styles.shareListLabel}>Shared with</p>
                {shares.map((s) => (
                  <div key={s.userId} className={styles.shareRow}>
                    <span className={styles.shareEmail}>{s.email}</span>
                    <button
                      type="button"
                      className={styles.removeBtn}
                      onClick={() => handleUnshare(s.userId)}
                      disabled={isPending}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
