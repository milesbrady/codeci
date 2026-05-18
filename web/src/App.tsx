import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Login } from "@/pages/Login";
import { TotpSetup } from "@/pages/TotpSetup";
import { TotpVerify } from "@/pages/TotpVerify";
import { EntraCallback } from "@/pages/EntraCallback";
import { Dashboard } from "@/pages/Dashboard";
import { PipelineList } from "@/pages/PipelineList";
import { PipelineCreate } from "@/pages/PipelineCreate";
import { PipelineEdit } from "@/pages/PipelineEdit";
import { PipelineRun } from "@/pages/PipelineRun";
import { PipelineTriggerConfig } from "@/pages/PipelineTriggerConfig";
import { ActiveRuns } from "@/pages/ActiveRuns";
import { RunHistory } from "@/pages/RunHistory";
import { RunDetail } from "@/pages/RunDetail";
import { UserProfile } from "@/pages/UserProfile";
import { Settings } from "@/pages/Settings";
import { ScriptList } from "@/pages/ScriptList";
import { ScriptCreate, ScriptEdit } from "@/pages/ScriptEditor";
import { ScriptRun } from "@/pages/ScriptRun";
import TerminalPage from "@/pages/Terminal";
import { Documentation } from "@/pages/Documentation";
import { ProtectedRoute, AdminRoute } from "@/components/ProtectedRoute";
import { useAuthStore } from "@/store/auth";
import { useAppConfigStore } from "@/store/appConfig";

// Polls the in-memory token every minute and triggers a hard logout the moment
// it crosses the JWT exp claim. Without this the user only learns the session
// died when the next API call returns 401, which can be a long wait if the tab
// is idle on a page that does no polling.
function SessionExpiryWatcher() {
  useEffect(() => {
    const id = window.setInterval(() => {
      const { token, isExpired, logout } = useAuthStore.getState();
      if (token && isExpired()) {
        logout();
        if (!window.location.pathname.startsWith("/login")) {
          window.location.href = "/login?expired=1";
        }
      }
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  return null;
}

// Loads the public app config once at boot and keeps the document title in sync
// with the brand name. Sub-second flash of "Codeci" is acceptable; the
// store's default lines up with the server default so most users won't see it.
function AppConfigBootstrap() {
  const name = useAppConfigStore((s) => s.name);
  const load = useAppConfigStore((s) => s.load);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    document.title = name;
  }, [name]);
  return null;
}

function TerminalGate() {
  const terminalEnabled = useAppConfigStore((s) => s.terminalEnabled);
  const loaded = useAppConfigStore((s) => s.loaded);
  if (loaded && !terminalEnabled) return <Navigate to="/dashboard" replace />;
  return <TerminalPage />;
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionExpiryWatcher />
      <AppConfigBootstrap />
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/totp/setup" element={<TotpSetup />} />
        <Route path="/totp/verify" element={<TotpVerify />} />
        <Route path="/auth/entra/callback" element={<EntraCallback />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/pipelines"
          element={
            <ProtectedRoute>
              <PipelineList />
            </ProtectedRoute>
          }
        />
        <Route
          path="/pipelines/create"
          element={
            <ProtectedRoute>
              <PipelineCreate />
            </ProtectedRoute>
          }
        />
        <Route
          path="/pipelines/:id/edit"
          element={
            <ProtectedRoute>
              <PipelineEdit />
            </ProtectedRoute>
          }
        />
        <Route
          path="/pipelines/:id/trigger"
          element={
            <AdminRoute>
              <PipelineTriggerConfig />
            </AdminRoute>
          }
        />
        <Route
          path="/pipelines/:id"
          element={
            <ProtectedRoute>
              <PipelineRun />
            </ProtectedRoute>
          }
        />
        <Route
          path="/active"
          element={
            <ProtectedRoute>
              <ActiveRuns />
            </ProtectedRoute>
          }
        />
        <Route
          path="/runs"
          element={
            <ProtectedRoute>
              <RunHistory />
            </ProtectedRoute>
          }
        />
        <Route
          path="/runs/:id"
          element={
            <ProtectedRoute>
              <RunDetail />
            </ProtectedRoute>
          }
        />
        <Route
          path="/scripts"
          element={
            <ProtectedRoute>
              <ScriptList />
            </ProtectedRoute>
          }
        />
        <Route
          path="/scripts/create"
          element={
            <ProtectedRoute>
              <ScriptCreate />
            </ProtectedRoute>
          }
        />
        <Route
          path="/scripts/:id/edit"
          element={
            <ProtectedRoute>
              <ScriptEdit />
            </ProtectedRoute>
          }
        />
        <Route
          path="/scripts/:id/run"
          element={
            <ProtectedRoute>
              <ScriptRun />
            </ProtectedRoute>
          }
        />
        <Route
          path="/terminal"
          element={
            <ProtectedRoute>
              <TerminalGate />
            </ProtectedRoute>
          }
        />
        <Route
          path="/docs"
          element={
            <ProtectedRoute>
              <Documentation />
            </ProtectedRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <UserProfile />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <AdminRoute>
              <Settings />
            </AdminRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
