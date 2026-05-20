"use client";

import { useEffect, useRef } from "react";

export type BoardEvent = { type: "board" | "ideas"; at: string };

// Wrapper around EventSource that:
//   - reports each server-pushed BoardEvent via onEvent
//   - also fires a synthetic event on (re)connect via onOpen, so a client that
//     missed updates while disconnected can recover state on its own
//   - uses a ref to onEvent/onOpen so swapping callbacks doesn't tear down the
//     connection on every parent re-render
//
// The browser's built-in EventSource handles retry/backoff (default 3s).
export function useBoardEvents(
  filter: BoardEvent["type"] | "all",
  onEvent: (event: BoardEvent) => void,
  onOpen?: () => void,
): void {
  const onEventRef = useRef(onEvent);
  const onOpenRef = useRef(onOpen);

  useEffect(() => {
    onEventRef.current = onEvent;
    onOpenRef.current = onOpen;
  }, [onEvent, onOpen]);

  useEffect(() => {
    const source = new EventSource("/api/events");

    source.onopen = () => {
      onOpenRef.current?.();
    };

    source.onmessage = (e) => {
      if (!e.data) return;
      try {
        const parsed = JSON.parse(e.data) as BoardEvent;
        if (filter !== "all" && parsed.type !== filter) return;
        onEventRef.current(parsed);
      } catch {
        // Ignore malformed payloads.
      }
    };

    source.onerror = () => {
      // Let the browser auto-reconnect; nothing to do here.
    };

    return () => {
      source.close();
    };
  }, [filter]);
}
