import { type WsExitInfo } from "@/lib/ws";
import { AlertCircle } from "lucide-react";

interface FailureSummaryProps {
  exitInfo: WsExitInfo;
}

/**
 * FailureSummary surfaces the most useful failure context — the failing
 * step name, the exit reason, and the last few stderr lines — at the top of
 * the run detail view, so users don't have to expand step logs to learn why
 * a run failed.
 */
export function FailureSummary({ exitInfo }: FailureSummaryProps) {
  if (exitInfo.code === 0) return null;

  const { failed_step, reason, last_stderr, code } = exitInfo;
  const headline = failed_step
    ? `Failed at step "${failed_step}"`
    : `Pipeline failed (exit ${code})`;

  return (
    <div className="rounded-lg border border-red-800/70 bg-red-950/30 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-red-200">{headline}</p>
          {reason && (
            <p className="text-xs text-red-300/90 mt-0.5">
              {reason}
            </p>
          )}
          {last_stderr && last_stderr.length > 0 && (
            <details className="mt-3 group" open>
              <summary className="text-[11px] uppercase tracking-wider text-red-300/70 font-semibold cursor-pointer hover:text-red-200 select-none">
                Last stderr ({last_stderr.length} {last_stderr.length === 1 ? "line" : "lines"})
              </summary>
              <pre className="mt-2 rounded bg-red-950/60 border border-red-900/60 p-2 font-mono text-[11px] text-red-200/90 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                {last_stderr.join("\n")}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
