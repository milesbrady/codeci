import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { statsApi, type DashboardStats } from "@/lib/api";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatElapsed } from "@/lib/utils";
import {
  Activity,
  CheckCircle2,
  Clock,
  History,
  Play,
  SlidersHorizontal,
  TrendingUp,
  Zap,
  ArrowRight,
} from "lucide-react";

type StatusVariant = "success" | "error" | "running" | "warning" | "default";

function statusVariant(status: string): StatusVariant {
  switch (status) {
    case "success": return "success";
    case "failed":  return "error";
    case "running": return "running";
    case "cancelled": return "warning";
    default: return "default";
  }
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatDay(date: string): { full: string; short: string; tiny: string } {
  const d = new Date(date + "T00:00:00Z");
  const full = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const short = d.toLocaleDateString(undefined, { weekday: "short" });
  const tiny = short.charAt(0);
  return { full, short, tiny };
}

function rateColor(rate: number): string {
  if (rate >= 0.9) return "text-emerald-400";
  if (rate >= 0.7) return "text-amber-400";
  return "text-red-400";
}

export function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const fetch = () =>
      statsApi.get()
        .then((res) => { if (!cancelled) { setStats(res.data); setError(""); } })
        .catch(() => { if (!cancelled) setError("Failed to load stats."); })
        .finally(() => { if (!cancelled) setLoading(false); });

    fetch();
    const VISIBLE_MS = 30_000;
    const HIDDEN_MS = 90_000;
    let interval: number | null = null;
    const restart = (ms: number) => {
      if (interval != null) clearInterval(interval);
      interval = window.setInterval(fetch, ms);
    };
    const onVisibility = () => {
      fetch();
      restart(document.visibilityState === "hidden" ? HIDDEN_MS : VISIBLE_MS);
    };
    restart(document.visibilityState === "hidden" ? HIDDEN_MS : VISIBLE_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (interval != null) clearInterval(interval);
    };
  }, []);

  return (
    <Layout>
      <PageHeader
        title="Dashboard"
        description="At-a-glance overview of pipelines and runs"
        action={
          <Button onClick={() => navigate("/pipelines")} className="gap-2">
            <Play className="h-4 w-4" />
            <span className="hidden sm:inline">Run a pipeline</span>
            <span className="sm:hidden">Run</span>
          </Button>
        }
      />
      <div className="p-4 md:p-8 space-y-6">
        {loading && <DashboardSkeleton />}

        {error && !loading && (
          <div className="rounded-lg bg-red-950/50 border border-red-800 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {!loading && !error && stats && (
          <>
            {/* KPI cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
              <StatCard
                icon={<SlidersHorizontal className="h-4 w-4 text-violet-400" />}
                tint="violet"
                label="Pipelines"
                value={stats.total_pipelines}
                hint="Configured"
                linkTo="/pipelines"
                linkLabel="Browse"
              />
              <StatCard
                icon={<Activity className={cn("h-4 w-4", stats.running_count > 0 ? "text-blue-400" : "text-zinc-400")} />}
                tint={stats.running_count > 0 ? "blue" : "zinc"}
                label="Running now"
                value={stats.running_count}
                pulsing={stats.running_count > 0}
                hint={stats.running_count > 0 ? "In progress" : "Idle"}
                linkTo={stats.running_count > 0 ? "/active" : undefined}
                linkLabel="View active"
              />
              <StatCard
                icon={<CheckCircle2 className={cn("h-4 w-4", rateColor(stats.success_rate))} />}
                tint="emerald"
                label="Success rate"
                value={stats.total_runs > 0 ? `${Math.round(stats.success_rate * 100)}%` : "—"}
                valueClass={stats.total_runs > 0 ? rateColor(stats.success_rate) : "text-zinc-500"}
                hint={`${stats.success_count.toLocaleString()} of ${stats.total_runs.toLocaleString()} runs`}
              />
              <StatCard
                icon={<Clock className="h-4 w-4 text-amber-400" />}
                tint="amber"
                label="Avg duration"
                value={stats.avg_duration_seconds > 0 ? formatElapsed(stats.avg_duration_seconds * 1000) : "—"}
                hint="Last 30 days"
              />
            </div>

            {stats.total_runs === 0 ? (
              <EmptyState onBrowse={() => navigate("/pipelines")} />
            ) : (
              <>
                {/* 7-day chart + Top pipelines */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <Card className="lg:col-span-2">
                    <CardContent className="p-4 md:p-6">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h2 className="text-sm font-semibold text-zinc-100">Runs · last 7 days</h2>
                          <p className="text-xs text-zinc-500 mt-0.5">Green = success · red = failed</p>
                        </div>
                        <TrendingUp className="h-4 w-4 text-zinc-500" />
                      </div>
                      <SevenDayChart buckets={stats.runs_7_days} />
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="p-4 md:p-6">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h2 className="text-sm font-semibold text-zinc-100">Top pipelines</h2>
                          <p className="text-xs text-zinc-500 mt-0.5">By run count (30d)</p>
                        </div>
                        <Zap className="h-4 w-4 text-zinc-500" />
                      </div>
                      <TopPipelinesList items={stats.top_pipelines} />
                    </CardContent>
                  </Card>
                </div>

                {/* Recent activity */}
                <Card>
                  <CardContent className="p-4 md:p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h2 className="text-sm font-semibold text-zinc-100">Recent activity</h2>
                        <p className="text-xs text-zinc-500 mt-0.5">Last 8 runs</p>
                      </div>
                      <Link to="/runs" className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300">
                        <History className="h-3.5 w-3.5" /> View all
                      </Link>
                    </div>
                    <ul className="divide-y divide-zinc-800/80">
                      {stats.recent_runs.length === 0 && (
                        <li className="text-sm text-zinc-500 py-4 text-center">No runs yet.</li>
                      )}
                      {stats.recent_runs.map((r) => {
                        const dur = r.FinishedAt
                          ? formatElapsed(new Date(r.FinishedAt).getTime() - new Date(r.StartedAt).getTime())
                          : "—";
                        return (
                          <li
                            key={r.ID}
                            onClick={() => navigate(`/runs/${r.ID}`)}
                            className="flex items-center gap-3 py-3 cursor-pointer hover:bg-zinc-800/30 rounded-lg px-2 -mx-2 transition-colors"
                          >
                            <Badge variant={statusVariant(r.Status)} className="shrink-0 capitalize">{r.Status}</Badge>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-zinc-100 truncate">{r.PipelineName}</p>
                              <p className="text-xs text-zinc-500 truncate">
                                <span className="hidden sm:inline">{r.UserName} · </span>
                                {formatRelative(r.StartedAt)}
                              </p>
                            </div>
                            <span className="hidden md:inline text-xs text-zinc-500 shrink-0 tabular-nums">{dur}</span>
                            <ArrowRight className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                          </li>
                        );
                      })}
                    </ul>
                  </CardContent>
                </Card>
              </>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}

type Tint = "violet" | "blue" | "emerald" | "amber" | "zinc";
const tintRing: Record<Tint, string> = {
  violet:  "bg-violet-600/15",
  blue:    "bg-blue-600/15",
  emerald: "bg-emerald-600/15",
  amber:   "bg-amber-600/15",
  zinc:    "bg-zinc-700/30",
};

function StatCard(props: {
  icon: React.ReactNode;
  tint: Tint;
  label: string;
  value: string | number;
  valueClass?: string;
  hint?: string;
  pulsing?: boolean;
  linkTo?: string;
  linkLabel?: string;
}) {
  const { icon, tint, label, value, valueClass, hint, pulsing, linkTo, linkLabel } = props;
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 md:p-5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-400 uppercase tracking-wide">{label}</span>
          <div className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md",
            tintRing[tint],
            pulsing && "animate-pulse"
          )}>
            {icon}
          </div>
        </div>
        <div className={cn("mt-3 text-2xl md:text-3xl font-semibold tabular-nums text-zinc-100", valueClass)}>
          {value}
        </div>
        {hint && (
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="text-xs text-zinc-500 truncate">{hint}</p>
            {linkTo && (
              <Link
                to={linkTo}
                className="text-[11px] text-violet-400 hover:text-violet-300 shrink-0 inline-flex items-center gap-0.5"
              >
                {linkLabel ?? "View"} <ArrowRight className="h-3 w-3" />
              </Link>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SevenDayChart({ buckets }: { buckets: { date: string; total: number; success: number; failed: number }[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return (
    <div>
      <div className="flex items-end gap-1.5 sm:gap-3 h-32 md:h-40">
        {buckets.map((b) => {
          const totalPct = (b.total / max) * 100;
          const successPct = b.total > 0 ? (b.success / b.total) * 100 : 0;
          const failedPct = b.total > 0 ? (b.failed / b.total) * 100 : 0;
          const otherPct = Math.max(0, 100 - successPct - failedPct);
          return (
            <div
              key={b.date}
              className="flex-1 flex flex-col items-center justify-end h-full group relative"
              title={`${b.date} · ${b.total} runs (${b.success} success, ${b.failed} failed)`}
            >
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                <div className="rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1 text-[10px] text-zinc-200 whitespace-nowrap shadow-lg">
                  {b.total} run{b.total !== 1 ? "s" : ""}
                </div>
              </div>
              <div
                className="w-full flex flex-col rounded-md overflow-hidden bg-zinc-800/50 border border-zinc-800 group-hover:border-violet-600/50 transition-colors"
                style={{ height: `${Math.max(totalPct, b.total > 0 ? 6 : 2)}%`, minHeight: 4 }}
              >
                {b.total > 0 && (
                  <>
                    {failedPct > 0 && <div className="bg-red-500/80" style={{ height: `${failedPct}%` }} />}
                    {otherPct > 0 && <div className="bg-zinc-600/60" style={{ height: `${otherPct}%` }} />}
                    {successPct > 0 && <div className="bg-emerald-500/80" style={{ height: `${successPct}%` }} />}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-end gap-1.5 sm:gap-3 mt-2">
        {buckets.map((b) => {
          const labels = formatDay(b.date);
          return (
            <div key={b.date} className="flex-1 text-center">
              <span className="text-[10px] text-zinc-500 hidden sm:inline">{labels.short}</span>
              <span className="text-[10px] text-zinc-500 sm:hidden">{labels.tiny}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TopPipelinesList({ items }: { items: { pipeline_id: string; pipeline_name: string; count: number }[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-zinc-500 py-4 text-center">No runs in the last 30 days.</p>;
  }
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="space-y-2.5">
      {items.map((p) => {
        const pct = (p.count / max) * 100;
        return (
          <li key={p.pipeline_id}>
            <Link
              to={`/pipelines/${p.pipeline_id}`}
              className="block group"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs text-zinc-200 truncate group-hover:text-violet-300 transition-colors">
                  {p.pipeline_name}
                </span>
                <span className="text-[11px] text-zinc-500 tabular-nums shrink-0">{p.count}</span>
              </div>
              <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-violet-500/70 group-hover:bg-violet-500 transition-colors rounded-full"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function EmptyState({ onBrowse }: { onBrowse: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12 text-center">
        <div className="h-14 w-14 rounded-full bg-violet-600/15 flex items-center justify-center mb-4">
          <Play className="h-6 w-6 text-violet-400" />
        </div>
        <h3 className="text-base font-medium text-zinc-100">No runs yet</h3>
        <p className="text-sm text-zinc-500 mt-1 max-w-sm">
          Pick a pipeline to configure parameters and kick off your first run.
        </p>
        <Button onClick={onBrowse} className="mt-4 gap-2">
          <SlidersHorizontal className="h-4 w-4" />
          Browse pipelines
        </Button>
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 rounded-xl bg-zinc-900/60 border border-zinc-800 animate-pulse" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 h-56 rounded-xl bg-zinc-900/60 border border-zinc-800 animate-pulse" />
        <div className="h-56 rounded-xl bg-zinc-900/60 border border-zinc-800 animate-pulse" />
      </div>
      <div className="h-64 rounded-xl bg-zinc-900/60 border border-zinc-800 animate-pulse" />
    </>
  );
}
