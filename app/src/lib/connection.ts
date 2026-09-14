import type { ServerMessage } from "./protocol";

const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 5000;

/**
 * Subscribes to a buffer's preview updates, reconnecting if the connection
 * drops. Returns a function that closes the connection.
 */
export function connect(
  bufnr: number,
  onMessage: (message: ServerMessage) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = MIN_RETRY_MS;
  let closed = false;

  const open = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${window.location.host}/ws?bufnr=${bufnr}`);
    socket.onopen = () => {
      retryDelay = MIN_RETRY_MS;
      onStatus(true);
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.error("invalid message from preview server", error);
        return;
      }
      // the preview was stopped in the editor: don't come back
      if (message.type === "close_page") closed = true;
      onMessage(message);
    };
    socket.onclose = () => {
      onStatus(false);
      if (closed) return;
      retry = setTimeout(open, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    };
  };
  open();

  return () => {
    closed = true;
    clearTimeout(retry);
    socket?.close();
  };
}
