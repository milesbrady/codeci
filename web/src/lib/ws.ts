export type WsMsgType =
  | "init"
  | "queued"        // run accepted but waiting for an open concurrency slot
  | "stdout"
  | "stderr"
  | "step"
  | "exit"
  | "error"
  | "meta"
  | "substep"       // runtime marker START: payload is the substep ID
  | "substep_end"   // runtime marker END: payload is the substep ID
  | "substep_plan"; // pre-execution plan; payload is the tree under `substeps`

/**
 * ExitInfo carries structured failure context attached to exit messages so
 * the UI can show users *why* a run failed without having to grep logs.
 */
export interface WsExitInfo {
  code: number;
  failed_step?: string;
  reason?: string;
  last_stderr?: string[];
}

/**
 * SubstepNode is one node in the statically-derived plan tree for a step.
 * IDs are hierarchical dot-paths ("1", "1.2", "1.2.3") and match the marker
 * payload that the runner emits at runtime.
 */
export interface SubstepNode {
  id: string;
  name: string;
  source?: string;
  children?: SubstepNode[];
}

export interface WsMessage {
  type: WsMsgType;
  data?: string;
  code?: number;
  run_id?: number;
  /** Server-assigned monotonic sequence; used as a stable React key. */
  seq?: number;
  /** Server clock at broadcast time, in Unix milliseconds. Used as the
   *  authoritative event time so per-step timers don't drift across
   *  re-renders or page refreshes. */
  time?: number;
  /** Name of the step this message belongs to (for routing into StepTracker). */
  step?: string;
  /** Free-form key/value annotations (codebuild build_id, console_url, phase, live_tail). */
  meta?: Record<string, string>;
  /** Structured failure info, set on the terminal exit message of a failed run. */
  exit_info?: WsExitInfo;
  /** Plan tree, set on substep_plan messages. */
  substeps?: SubstepNode[];
}

export type WsListener = (msg: WsMessage) => void;

export function createExecSocket(
  pipelineId: string,
  params: Record<string, string>,
  onMessage: WsListener,
  onClose: () => void,
  runId?: number,
  onOpen?: () => void,
): WebSocket {
  const token = sessionStorage.getItem("token") ?? "";
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = window.location.host;
  const url = `${protocol}://${host}/ws/execute/${pipelineId}?token=${encodeURIComponent(token)}`;

  const ws = new WebSocket(url);

  ws.onopen = () => {
    if (runId) {
      ws.send(JSON.stringify({ run_id: runId }));
    } else {
      ws.send(JSON.stringify({ params }));
    }
    onOpen?.();
  };

  ws.onmessage = (event) => {
    try {
      const msg: WsMessage = JSON.parse(event.data as string);
      onMessage(msg);
    } catch {
      // ignore malformed frames
    }
  };

  ws.onclose = onClose;

  return ws;
}

export interface TerminalControl {
  type: "ready" | "error" | "timeout";
  data?: string;
  container?: string;
}

/**
 * createTerminalSocket opens an interactive PTY-backed WebSocket against the
 * runner-shell endpoint. PTY output is delivered as binary frames (raw bytes
 * — fed straight to xterm); control messages (ready / error / timeout) and
 * input + resize events are JSON text frames.
 */
export function createTerminalSocket(
  onBinary: (bytes: Uint8Array) => void,
  onControl: (msg: TerminalControl) => void,
  onClose: () => void,
): WebSocket {
  const token = sessionStorage.getItem("token") ?? "";
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = window.location.host;
  const url = `${protocol}://${host}/ws/terminal?token=${encodeURIComponent(token)}`;

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      onBinary(new Uint8Array(event.data));
      return;
    }
    try {
      const msg = JSON.parse(event.data as string) as TerminalControl;
      onControl(msg);
    } catch {
      // ignore malformed frames
    }
  };

  ws.onclose = onClose;

  return ws;
}

export function createScriptSocket(
  scriptId: string,
  onMessage: WsListener,
  onClose: () => void,
): WebSocket {
  const token = sessionStorage.getItem("token") ?? "";
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = window.location.host;
  const url = `${protocol}://${host}/ws/scripts/${scriptId}?token=${encodeURIComponent(token)}`;

  const ws = new WebSocket(url);

  ws.onmessage = (event) => {
    try {
      const msg: WsMessage = JSON.parse(event.data as string);
      onMessage(msg);
    } catch {
      // ignore malformed frames
    }
  };

  ws.onclose = onClose;

  return ws;
}
