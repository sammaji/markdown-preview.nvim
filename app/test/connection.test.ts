// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { connect } from "@/lib/connection";
import type { ServerMessage } from "@/lib/protocol";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closeCalls = 0;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closeCalls++;
  }

  // server side
  open() {
    this.onopen?.();
  }
  send(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  drop() {
    this.onclose?.();
  }
}

const sockets = () => FakeWebSocket.instances;
const latest = () => sockets()[sockets().length - 1];

function setup(protocol = "http:", host = "localhost:8090", bufnr = 3) {
  vi.stubGlobal("window", { location: { protocol, host } });
  const onMessage = vi.fn<(message: ServerMessage) => void>();
  const onStatus = vi.fn<(connected: boolean) => void>();
  const dispose = connect(bufnr, onMessage, onStatus);
  return { onMessage, onStatus, dispose };
}

// drops the current socket and returns how long the page waited before
// opening the next one
function reconnectDelay(): number {
  const before = sockets().length;
  latest().drop();
  let waited = 0;
  while (sockets().length === before) {
    vi.advanceTimersByTime(1);
    waited++;
    if (waited > 60_000) throw new Error("did not reconnect");
  }
  return waited;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connect", () => {
  test("opens ws://host/ws?bufnr=N", () => {
    setup("http:", "localhost:8090", 7);
    expect(sockets()).toHaveLength(1);
    expect(latest().url).toBe("ws://localhost:8090/ws?bufnr=7");
  });

  test("uses wss:// when the page is served over https", () => {
    setup("https:", "preview.example.com", 12);
    expect(latest().url).toBe("wss://preview.example.com/ws?bufnr=12");
  });

  test("reports the connection status", () => {
    const { onStatus } = setup();
    expect(onStatus).not.toHaveBeenCalled();
    latest().open();
    expect(onStatus).toHaveBeenLastCalledWith(true);
    latest().drop();
    expect(onStatus).toHaveBeenLastCalledWith(false);
    expect(onStatus.mock.calls).toEqual([[true], [false]]);
  });

  test("passes parsed messages on", () => {
    const { onMessage } = setup();
    latest().open();
    const message = { type: "change_bufnr", bufnr: 4 } as const;
    latest().send(message);
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(message);
  });

  test("ignores invalid JSON and keeps going", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { onMessage, onStatus } = setup();
    latest().open();
    expect(() => latest().send("{not json")).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(latest().closeCalls).toBe(0);

    latest().send({ type: "close_page" });
    expect(onMessage).toHaveBeenCalledExactlyOnceWith({ type: "close_page" });
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(true);
  });

  test("reconnects with a backoff doubling from 500ms up to 5s", () => {
    setup();
    const delays = Array.from({ length: 7 }, () => reconnectDelay());
    expect(delays).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
    expect(sockets().every((socket) => socket.url === "ws://localhost:8090/ws?bufnr=3")).toBe(true);
  });

  test("resets the backoff after a successful connection", () => {
    setup();
    expect([reconnectDelay(), reconnectDelay(), reconnectDelay()]).toEqual([500, 1000, 2000]);
    latest().open();
    expect([reconnectDelay(), reconnectDelay()]).toEqual([500, 1000]);
  });

  test("does not reconnect after close_page", () => {
    const { onMessage, onStatus } = setup();
    latest().open();
    latest().send({ type: "close_page" });
    expect(onMessage).toHaveBeenCalledWith({ type: "close_page" });
    latest().drop();
    expect(onStatus).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(60_000);
    expect(sockets()).toHaveLength(1);
  });

  test("other messages do not stop reconnecting", () => {
    setup();
    latest().open();
    latest().send({ type: "change_bufnr", bufnr: 1 });
    expect(reconnectDelay()).toBe(500);
  });

  test("dispose closes the socket and stops reconnecting", () => {
    const { dispose } = setup();
    latest().open();
    dispose();
    expect(latest().closeCalls).toBe(1);
    latest().drop();
    vi.advanceTimersByTime(60_000);
    expect(sockets()).toHaveLength(1);
  });

  test("dispose cancels a pending reconnect", () => {
    const { dispose } = setup();
    latest().drop();
    dispose();
    vi.advanceTimersByTime(60_000);
    expect(sockets()).toHaveLength(1);
  });
});
