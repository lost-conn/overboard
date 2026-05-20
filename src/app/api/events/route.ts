import { currentSession } from "@/lib/auth";
import { subscribe, type BoardEvent } from "@/lib/events/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) {
    return new Response("unauthorized", { status: 401 });
  }
  const userId = session.userId;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };

      // Initial frame so the client's onopen fires immediately and the connection
      // is unambiguously established (also flushes through any proxies that buffer
      // until they see bytes).
      send(`: connected\n\n`);
      send(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

      const unsubscribe = subscribe(userId, (event: BoardEvent) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      });

      const heartbeat = setInterval(() => {
        send(`: keepalive\n\n`);
      }, HEARTBEAT_MS);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        close();
      };

      // Client disconnect / aborted fetch
      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defense in depth — Caddy is already configured with flush_interval -1.
      "X-Accel-Buffering": "no",
    },
  });
}
