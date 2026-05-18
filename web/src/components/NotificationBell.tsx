import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, BellOff, CheckCheck, Trash2, X, CheckCircle2, XCircle, Info } from "lucide-react";
import { useNotificationsStore, type NotificationItem } from "@/store/notifications";
import { cn } from "@/lib/utils";

function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

function KindIcon({ kind }: { kind: NotificationItem["kind"] }) {
  if (kind === "success") return <CheckCircle2 className="h-4 w-4 text-emerald-400 flex-shrink-0" />;
  if (kind === "failed")  return <XCircle      className="h-4 w-4 text-red-400 flex-shrink-0" />;
  return <Info className="h-4 w-4 text-violet-400 flex-shrink-0" />;
}

export function NotificationBell() {
  const navigate = useNavigate();
  const {
    items,
    permission,
    markRead,
    markAllRead,
    remove,
    clear,
    requestPermission,
    refreshPermission,
    testBrowserNotification,
  } = useNotificationsStore();
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const unread = items.filter((i) => !i.read).length;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [open]);

  void tick;

  function handleItemClick(item: NotificationItem) {
    if (!item.read) markRead(item.id);
    setOpen(false);
    if (item.runId != null) navigate(`/runs/${item.runId}`);
  }

  async function handleEnable() {
    const result = await requestPermission();
    refreshPermission();
    if (result !== "granted") {
      // Browser denied or dismissed — nothing else we can do; user must change site setting.
    }
  }

  function handleTest() {
    refreshPermission();
    const r = testBrowserNotification();
    if (r.ok) {
      setTestStatus("Sent — check your desktop. If you don't see it, check macOS Notification settings for Firefox (System Settings → Notifications) and that Do Not Disturb / Focus is off.");
    } else {
      setTestStatus(`Could not show desktop notification: ${r.reason ?? "unknown"}.`);
    }
    window.setTimeout(() => setTestStatus(null), 8000);
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative h-8 w-8 flex items-center justify-center rounded-lg transition-colors",
          open ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
        )}
        aria-label="Notifications"
        title="Notifications"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white shadow ring-2 ring-zinc-900">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 z-50 w-[22rem] max-h-[28rem] flex flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-zinc-400" />
              <p className="text-sm font-semibold text-zinc-100">Notifications</p>
              {unread > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-300 font-semibold">
                  {unread} new
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {items.length > 0 && unread > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  title="Mark all as read"
                  className="h-7 w-7 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                </button>
              )}
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={clear}
                  title="Clear all"
                  className="h-7 w-7 flex items-center justify-center rounded text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Permission banner */}
          {permission === "default" && (
            <div className="px-4 py-3 border-b border-zinc-800 bg-violet-950/20">
              <p className="text-xs text-zinc-300">
                Get a desktop alert when a job finishes — even if this tab is in the background.
              </p>
              <button
                type="button"
                onClick={handleEnable}
                className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium transition-colors"
              >
                <Bell className="h-3 w-3" />
                Enable browser notifications
              </button>
            </div>
          )}
          {permission === "denied" && (
            <div className="px-4 py-2 border-b border-zinc-800 bg-zinc-950/60">
              <p className="text-[11px] text-zinc-500 flex items-start gap-1.5">
                <BellOff className="h-3 w-3 mt-0.5 flex-shrink-0" />
                Browser notifications are blocked. Enable them in your browser's site settings to get desktop alerts.
              </p>
            </div>
          )}
          {permission === "unsupported" && (
            <div className="px-4 py-2 border-b border-zinc-800 bg-zinc-950/60">
              <p className="text-[11px] text-zinc-500">
                This browser does not support desktop notifications. The bell will still capture run completions while this tab is open.
              </p>
            </div>
          )}
          {permission === "granted" && (
            <div className="px-4 py-2 border-b border-zinc-800 bg-zinc-950/40 flex items-center justify-between gap-2">
              <p className="text-[11px] text-zinc-500">
                Desktop notifications enabled. They appear when this tab is in the background.
              </p>
              <button
                type="button"
                onClick={handleTest}
                className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-violet-300 hover:text-violet-200 hover:bg-zinc-800 transition-colors"
                title="Send a test desktop notification"
              >
                <Bell className="h-3 w-3" />
                Test
              </button>
            </div>
          )}
          {testStatus && (
            <div className="px-4 py-2 border-b border-zinc-800 bg-zinc-950/40">
              <p className="text-[11px] text-zinc-400">{testStatus}</p>
            </div>
          )}

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center px-4">
                <div className="h-10 w-10 rounded-full bg-zinc-800 flex items-center justify-center mb-2">
                  <Bell className="h-4 w-4 text-zinc-500" />
                </div>
                <p className="text-xs text-zinc-400">You're all caught up</p>
                <p className="text-[10px] text-zinc-600 mt-1">
                  We'll let you know when a pipeline finishes.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-zinc-800">
                {items.map((it) => (
                  <li
                    key={it.id}
                    className={cn(
                      "group relative px-4 py-3 cursor-pointer hover:bg-zinc-800/60 transition-colors",
                      !it.read && "bg-violet-950/10"
                    )}
                    onClick={() => handleItemClick(it)}
                  >
                    <div className="flex items-start gap-2.5">
                      <KindIcon kind={it.kind} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className={cn(
                            "text-sm truncate",
                            it.read ? "text-zinc-300" : "text-zinc-100 font-semibold"
                          )}>
                            {it.title}
                          </p>
                          {!it.read && <span className="h-1.5 w-1.5 rounded-full bg-violet-400 flex-shrink-0" />}
                        </div>
                        <p className="text-xs text-zinc-400 truncate">{it.message}</p>
                        <p className="text-[10px] text-zinc-600 mt-0.5">{timeAgo(it.createdAt)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); remove(it.id); }}
                        className="h-6 w-6 flex items-center justify-center rounded text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                        aria-label="Dismiss"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
