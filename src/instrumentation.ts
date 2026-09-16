// Runs once when the Next.js server instance starts. Used here to start the
// background sweep that moves overdue "expires" cards into the FAILED lane
// every minute, so the board stays current even with no one's tab open.
// See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSweeper } = await import("@/lib/board/sweeper");
    startSweeper();
  }
}
