import { currentSession } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { parseBackup, importBackup, type ImportMode } from "@/lib/restore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await currentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "request body must be an object" }, { status: 400 });
  }
  const { mode, data } = body as { mode?: unknown; data?: unknown };
  if (mode !== "merge" && mode !== "replace") {
    return Response.json({ error: "mode must be 'merge' or 'replace'" }, { status: 400 });
  }

  try {
    const backup = parseBackup(data);
    const imported = await importBackup(session.userId, backup, mode as ImportMode);
    return Response.json({ ok: true, mode, imported });
  } catch (err) {
    if (err instanceof ValidationError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error("restore failed", err);
    return Response.json({ error: "import failed" }, { status: 500 });
  }
}
