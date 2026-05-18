import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Zap, ShieldCheck } from "lucide-react";

export function TotpSetup() {
  const navigate = useNavigate();
  const { setAuth, username } = useAuthStore();
  const [qrImage, setQrImage] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingQr, setLoadingQr] = useState(true);

  useEffect(() => {
    authApi.totpSetup()
      .then((res) => setQrImage(res.data.qr_image))
      .catch(() => setError("Failed to generate QR code."))
      .finally(() => setLoadingQr(false));
  }, []);

  async function verify() {
    if (code.length !== 6) { setError("Enter a 6-digit code."); return; }
    setLoading(true);
    setError("");
    try {
      const res = await authApi.totpVerify(code);
      setAuth(res.data.token, true, username ?? "");
      navigate("/pipelines");
    } catch {
      setError("Invalid code. Try again.");
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
          <h1 className="text-2xl font-bold text-zinc-100">Set up 2FA</h1>
          <p className="text-sm text-zinc-400 mt-1">Scan the QR code with Microsoft Authenticator</p>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-6">
          <div className="flex flex-col items-center gap-4">
            {loadingQr ? (
              <div className="h-48 w-48 rounded-lg bg-zinc-800 animate-pulse" />
            ) : qrImage ? (
              <img src={qrImage} alt="TOTP QR Code" className="h-48 w-48 rounded-lg border border-zinc-700" />
            ) : (
              <div className="h-48 w-48 rounded-lg bg-zinc-800 flex items-center justify-center">
                <p className="text-xs text-zinc-500">Failed to load QR</p>
              </div>
            )}
            <div className="text-center">
              <p className="text-xs text-zinc-500">Scan with</p>
              <p className="text-sm font-medium text-zinc-300">Microsoft Authenticator</p>
            </div>
          </div>

          <div className="border-t border-zinc-800 pt-5 space-y-3">
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <ShieldCheck className="h-4 w-4 text-violet-400" />
              Enter the 6-digit code to verify
            </div>
            <Input
              placeholder="000000"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="text-center text-lg tracking-[0.5em] font-mono"
              autoComplete="one-time-code"
              inputMode="numeric"
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <Button className="w-full" onClick={verify} loading={loading} size="lg">
              Verify &amp; Continue
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
