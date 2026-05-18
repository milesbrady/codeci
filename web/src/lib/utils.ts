import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const ERROR_PATTERNS = [
  // Structured logging
  /"level"\s*:\s*"(ERROR|FATAL|CRITICAL)"/i,
  /"err"\s*:\s*"[^"]+"/,
  // Generic prefixes
  /^(Error|ERROR|FATAL|CRITICAL|Exception|EXCEPTION)\b/,
  /\b(Error|ERROR|FATAL):/,
  /^\[(error|fatal)\]/i,
  /\[error\]/i,
  /\[fatal\]/i,
  /failed to /i,
  // Go runtime
  /^panic:/,
  /^fatal error:/,
  /^runtime error:/,
  // Python tracebacks
  /^Traceback \(most recent call last\)/,
  /^\s*File ".+", line \d+, in /,
  // Node / JS stack frames
  /^\s+at .* \(.*:\d+:\d+\)/,
  /^\s+at .*:\d+:\d+/,
  // Docker
  /^Error response from daemon/,
  /pull access denied/,
  /manifest unknown/,
  /no space left on device/,
  // Bash / shell
  /: command not found/,
  /: cannot access /,
  /: Permission denied/,
  // CodeBuild common
  /COMMAND_EXECUTION_ERROR/,
  /CLIENT_ERROR/,
];

/** Returns true if a stderr line should be treated as a genuine error. */
export function isErrorLine(text: string): boolean {
  return ERROR_PATTERNS.some((re) => re.test(text));
}

/** Triggers a browser download for an in-memory Blob with the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Formats milliseconds as a human-friendly elapsed string.
 * <1m   → "Xs" (one decimal under a minute)
 * <1h   → "XmYs"
 * ≥1h   → "XhYmZs"
 */
export function formatElapsed(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}
