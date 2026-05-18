import { Navigate } from "react-router-dom";
import { useAuthStore } from "@/store/auth";

function BootSplash() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="text-zinc-500 text-sm">Loading…</div>
    </div>
  );
}

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token, totpPassed, bootstrapping } = useAuthStore();
  if (bootstrapping) return <BootSplash />;
  if (!token) return <Navigate to="/login" replace />;
  if (!totpPassed) return <Navigate to="/totp/verify" replace />;
  return <>{children}</>;
}

export function AdminRoute({ children }: { children: React.ReactNode }) {
  const { token, totpPassed, isAdmin, bootstrapping } = useAuthStore();
  if (bootstrapping) return <BootSplash />;
  if (!token) return <Navigate to="/login" replace />;
  if (!totpPassed) return <Navigate to="/totp/verify" replace />;
  if (!isAdmin) return <Navigate to="/pipelines" replace />;
  return <>{children}</>;
}
