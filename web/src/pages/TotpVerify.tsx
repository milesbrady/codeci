import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useAppConfigStore } from "@/store/appConfig";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Zap, Shield } from "lucide-react";

export function TotpVerify() {
  const navigate = useNavigate();
  const { setAuth, setMustChangePassword, username, mustChangePassword } = useAuthStore();
  const appName = useAppConfigStore((s) => s.name);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function verify() {
    if (code.length !== 6) { setError("Enter a 6-digit code."); return; }
    setLoading(true);
    setError("");
    try {
      const res = await authApi.totpVerify(code);
      setAuth(res.data.token, true, username ?? "");
      if (mustChangePassword) {
        setMustChangePassword(true);
        navigate("/profile");
      } else {
        navigate("/dashboard");
      }
    } catch {
      setError("Invalid or expired code. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-600 mb-4">
            <Zap className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">Two-Factor Auth</h1>
          <p className="text-sm text-zinc-400 mt-1">Enter the code from your authenticator app</p>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-5">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-violet-950/40 border border-violet-800/40">
            <Shield className="h-5 w-5 text-violet-400 flex-shrink-0" />
            <p className="text-sm text-violet-300">
              Open <strong>Microsoft Authenticator</strong> and enter the 6-digit code for {appName}.
            </p>
          </div>

          <div className="space-y-3">
            <Input
              placeholder="000000"
              maxLength={6}
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, ""));
                setError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && verify()}
              className="text-center text-2xl tracking-[0.75em] font-mono"
              autoComplete="one-time-code"
              inputMode="numeric"
              autoFocus
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <Button className="w-full" onClick={verify} loading={loading} size="lg">
              Verify
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
