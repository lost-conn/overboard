import { currentSession } from "@/lib/auth";
import { backupFilename, buildBackupFile } from "@/lib/backup";

// Deliberately thin. Everything about *what* a backup contains lives in
// src/lib/backup.ts so it can be tested without a session or an HTTP layer —
// see the note there. This file owns only auth and the download headers.

export async function GET() {
  const session = await currentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await buildBackupFile(session.userId);

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${backupFilename()}"`,
    },
  });
}
