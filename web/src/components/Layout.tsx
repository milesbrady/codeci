import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/auth";
import { useAppConfigStore } from "@/store/appConfig";
import { useNotificationsStore } from "@/store/notifications";
import { runsApi, type ExecutionRun } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/NotificationBell";
import { LayoutDashboard, Activity, History, LogOut, Zap, Settings, User, Terminal, TerminalSquare, BookOpen, Menu, X, SlidersHorizontal } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { username, isAdmin, logout } = useAuthStore();
  const appName = useAppConfigStore((s) => s.name);
  const appVersion = useAppConfigStore((s) => s.version);
  const terminalEnabled = useAppConfigStore((s) => s.terminalEnabled);
  const [activeCount, setActiveCount] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const addNotification = useNotificationsStore((s) => s.add);

  // Auto-close the mobile drawer when the route changes (tap-to-navigate UX).
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Track which runs were "running" on the previous poll, so we can detect
  // running -> success/failed transitions and emit a notification exactly
  // once per completion. Initialised lazily on the first response so we
  // don't notify for runs that finished before the user logged in.
  const prevRunningRef = useRef<Map<number, ExecutionRun> | null>(null);
  const notifiedRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const fetch = () =>
      // Lean endpoint — payload no longer carries LogsJSON / ParamsJSON.
      // We resolve final status of just-completed runs with a one-off GET.
      runsApi.listActive().then(async (res) => {
        if (cancelled) return;
        const running = res.data;
        setActiveCount(running.length);

        const currentRunning = new Map<number, ExecutionRun>();
        for (const r of running) currentRunning.set(r.ID, r);

        const prev = prevRunningRef.current;
        if (prev != null) {
          for (const [id, run] of prev) {
            if (currentRunning.has(id)) continue; // still running
            if (notifiedRef.current.has(id)) continue; // already notified

            // Run disappeared from the active list → fetch its final state
            // so we can categorize the notification correctly. Best-effort:
            // on failure, fall back to a generic "finished".
            let status = "finished";
            let name = run.PipelineName ?? `Run #${id}`;
            let pipelineId = run.PipelineID;
            try {
              const r = await runsApi.get(id);
              if (cancelled) return;
              status = r.data.Status ?? "finished";
              name = r.data.PipelineName ?? name;
              pipelineId = r.data.PipelineID ?? pipelineId;
            } catch {
              // ignore
            }

            const kind = status === "success" ? "success" : status === "failed" ? "failed" : "info";
            const verb =
              status === "success" ? "completed successfully" :
              status === "failed"  ? "failed" :
              status === "cancelled" ? "was cancelled" : "finished";
            addNotification({
              runId: id,
              pipelineId,
              pipelineName: name,
              kind,
              title: `${name} ${verb}`,
              message: `Run #${id} ${verb}.`,
            });
            notifiedRef.current.add(id);
          }
        }
        prevRunningRef.current = currentRunning;
      }).catch(() => {});

    // Keep polling even when the tab is hidden — that is precisely when
    // we need to detect run completions to fire a desktop notification.
    // Slow the cadence down to be polite, but never stop entirely.
    let interval: number | null = null;
    const VISIBLE_MS = 5000;
    const HIDDEN_MS = 15000;
    const restart = (period: number) => {
      if (interval != null) clearInterval(interval);
      interval = window.setInterval(fetch, period);
    };
    const onVisibility = () => {
      // Fetch immediately on visibility flip so the bell catches up.
      fetch();
      restart(document.visibilityState === "hidden" ? HIDDEN_MS : VISIBLE_MS);
    };
    document.addEventListener("visibilitychange", onVisibility);

    fetch();
    restart(document.visibilityState === "hidden" ? HIDDEN_MS : VISIBLE_MS);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (interval != null) clearInterval(interval);
    };
  }, [addNotification]);

  function handleLogout() {
    logout();
    navigate("/login");
  }

  const nav = [
    { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, badge: 0 },
    { label: "Pipelines", href: "/pipelines", icon: SlidersHorizontal, badge: 0 },
    { label: "Scripts", href: "/scripts", icon: Terminal, badge: 0 },
    { label: "Active Runs", href: "/active", icon: Activity, badge: activeCount },
    { label: "Run History", href: "/runs", icon: History, badge: 0 },
    ...(terminalEnabled
      ? [{ label: "Terminal", href: "/terminal", icon: TerminalSquare, badge: 0 }]
      : []),
    { label: "Documentation", href: "/docs", icon: BookOpen, badge: 0 },
  ];

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-zinc-800">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600">
          <Zap className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-100 truncate" title={appName}>{appName}</p>
          <p className="text-xs text-zinc-500">
            Pipeline Runner{appVersion && <span className="ml-1 text-zinc-600">· v{appVersion}</span>}
          </p>
        </div>
        {/* Bell lives in sidebar on desktop, and in mobile top bar otherwise. */}
        <div className="hidden md:block">
          <NotificationBell />
        </div>
        {/* Mobile-only close button — only visible inside the drawer. */}
        <button
          onClick={() => setMobileOpen(false)}
          className="md:hidden rounded p-1 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          aria-label="Close menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {nav.map(({ label, href, icon: Icon, badge }) => (
          <Link
            key={href}
            to={href}
            className={cn(
              "flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors",
              location.pathname.startsWith(href)
                ? "bg-violet-600/20 text-violet-300"
                : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
            )}
          >
            <span className="flex items-center gap-3">
              <Icon className="h-4 w-4" />
              {label}
            </span>
            {badge > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-violet-600 px-1.5 text-[10px] font-bold text-white">
                {badge}
              </span>
            )}
          </Link>
        ))}

        {/* Admin-only: Settings */}
        {isAdmin && (
          <Link
            to="/settings"
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
              location.pathname.startsWith("/settings")
                ? "bg-violet-600/20 text-violet-300"
                : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
            )}
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>
        )}
      </nav>

      {/* User */}
      <div className="border-t border-zinc-800 px-3 py-3 space-y-1">
        <Link
          to="/profile"
          className={cn(
            "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
            location.pathname === "/profile"
              ? "bg-violet-600/20 text-violet-300"
              : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
          )}
        >
          <div className="h-6 w-6 rounded-full bg-violet-600/30 flex items-center justify-center flex-shrink-0">
            <span className="text-[10px] font-bold text-violet-300">
              {username?.[0]?.toUpperCase() ?? "U"}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="truncate text-zinc-100">{username}</p>
            {isAdmin && (
              <p className="text-[10px] text-amber-500 font-medium -mt-0.5">Administrator</p>
            )}
          </div>
          <User className="h-4 w-4 text-zinc-500" />
        </Link>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-red-400 hover:bg-red-400/10 transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 flex-shrink-0 border-r border-zinc-800 bg-zinc-900/50 flex-col">
        {sidebarContent}
      </aside>

      {/* Mobile drawer + backdrop */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/60"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={cn(
          "md:hidden fixed inset-y-0 left-0 z-40 w-64 border-r border-zinc-800 bg-zinc-900 flex flex-col transform transition-transform duration-200",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {sidebarContent}
      </aside>

      {/* Main column (top bar on mobile, content below) */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-3 h-14 border-b border-zinc-800 bg-zinc-900/60 px-4 flex-shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded p-1.5 text-zinc-300 hover:bg-zinc-800 transition-colors"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-violet-600 flex-shrink-0">
              <Zap className="h-3.5 w-3.5 text-white" />
            </div>
            <p className="text-sm font-semibold text-zinc-100 truncate">{appName}</p>
          </div>
          <NotificationBell />
        </div>

        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between px-4 md:px-8 py-4 md:py-6 border-b border-zinc-800">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-zinc-100 truncate">{title}</h1>
        {description && <p className="text-sm text-zinc-400 mt-0.5">{description}</p>}
      </div>
      {action && (
        <div className="flex flex-wrap items-center gap-2">{action}</div>
      )}
    </div>
  );
}
