import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi, meApi, type MeInfo } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { Layout, PageHeader } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { User, Shield, Key, ShieldOff, ShieldCheck, AlertTriangle, LogOut } from "lucide-react";
import { ApiKeysCard } from "@/components/ApiKeysCard";

export function UserProfile() {
  const navigate = useNavigate();
  const { setAuth, setMustChangePassword, mustChangePassword, username, logout } = useAuthStore();
  const [me, setMe] = useState<MeInfo | null>(null);

  // Password change form
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState("");
  const [pwLoading, setPwLoading] = useState(false);

  // TOTP setup state
  const [qrImage, setQrImage] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpError, setTotpError] = useState("");
  const [totpLoading, setTotpLoading] = useState(false);
  const [showTotpSetup, setShowTotpSetup] = useState(false);

  // TOTP disable
  const [disableLoading, setDisableLoading] = useState(false);
  const [disableError, setDisableError] = useState("");

  useEffect(() => {
    meApi.get().then((r) => setMe(r.data)).catch(() => {});
  }, []);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError("");
    setPwSuccess("");
    if (newPw.length < 8) { setPwError("New password must be at least 8 characters."); return; }
    if (newPw !== confirmPw) { setPwError("Passwords do not match."); return; }
    setPwLoading(true);
    try {
      await authApi.changePassword(currentPw, newPw);
      setPwSuccess("Password changed successfully.");
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
      setMustChangePassword(false);
      setMe((prev) => prev ? { ...prev, must_change_password: false } : prev);
    } catch (err: any) {
      setPwError(err?.response?.data?.message ?? "Failed to change password.");
    } finally {
      setPwLoading(false);
    }
  }

  async function handleTotpSetup() {
    setTotpError("");
    setTotpLoading(true);
    try {
      const res = await authApi.totpSetup();
      setQrImage(res.data.qr_image);
      setShowTotpSetup(true);
    } catch {
      setTotpError("Failed to generate QR code.");
    } finally {
      setTotpLoading(false);
    }
  }

  async function handleTotpVerify() {
    if (totpCode.length !== 6) { setTotpError("Enter a 6-digit code."); return; }
    setTotpLoading(true);
    setTotpError("");
    try {
      const res = await authApi.totpVerify(totpCode);
      setAuth(res.data.token, true, username ?? "");
      setMe((prev) => prev ? { ...prev, totp_enabled: true } : prev);
      setShowTotpSetup(false);
      setQrImage("");
      setTotpCode("");
    } catch {
      setTotpError("Invalid code. Try again.");
    } finally {
      setTotpLoading(false);
    }
  }

  async function handleTotpDisable() {
    setDisableError("");
    setDisableLoading(true);
    try {
      await authApi.totpDisable();
      setMe((prev) => prev ? { ...prev, totp_enabled: false } : prev);
      setShowTotpSetup(false);
    } catch {
      setDisableError("Failed to disable TOTP.");
    } finally {
      setDisableLoading(false);
    }
  }

  return (
    <Layout>
      <PageHeader
        title="My Profile"
        description="Manage your account settings and security"
      />
      <div className="p-8 max-w-2xl space-y-6">

        {/* Must-change-password banner */}
        {mustChangePassword && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-700/50 bg-amber-950/30 px-4 py-3">
            <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-300">Password change required</p>
              <p className="text-xs text-amber-500 mt-0.5">
                Your administrator has reset your password. Please set a new one below.
              </p>
            </div>
          </div>
        )}

        {/* Account info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <User className="h-4 w-4" />
              Account Info
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">Username</span>
              <span className="text-sm text-zinc-200 font-mono">{me?.username ?? username}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">Role</span>
              <Badge variant={me?.role === "admin" ? "warning" : "default"}>
                {me?.role ?? "user"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">Two-Factor Auth</span>
              <Badge variant={me?.totp_enabled ? "success" : "default"}>
                {me?.totp_enabled ? "enabled" : "disabled"}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Change password */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Key className="h-4 w-4" />
              Change Password
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleChangePassword} className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">Current password</label>
                <Input
                  type="password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">New password</label>
                <Input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  placeholder="Min. 8 characters"
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">Confirm new password</label>
                <Input
                  type="password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </div>
              {pwError && <p className="text-xs text-red-400">{pwError}</p>}
              {pwSuccess && <p className="text-xs text-emerald-400">{pwSuccess}</p>}
              <Button type="submit" size="sm" loading={pwLoading}>
                Update Password
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Two-Factor Authentication */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Two-Factor Authentication
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!me?.totp_enabled && !showTotpSetup && (
              <div className="space-y-3">
                <p className="text-sm text-zinc-400">
                  Add an extra layer of security by requiring a code from your authenticator app on each login.
                </p>
                <Button size="sm" onClick={handleTotpSetup} loading={totpLoading}>
                  <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
                  Enable 2FA
                </Button>
                {totpError && <p className="text-xs text-red-400">{totpError}</p>}
              </div>
            )}

            {showTotpSetup && (
              <div className="space-y-4">
                <p className="text-sm text-zinc-400">
                  Scan this QR code with your authenticator app, then enter the 6-digit code to confirm.
                </p>
                {qrImage && (
                  <div className="flex justify-center">
                    <img
                      src={qrImage}
                      alt="TOTP QR Code"
                      className="h-48 w-48 rounded-lg border border-zinc-700 bg-white"
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Input
                    placeholder="000000"
                    maxLength={6}
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
                    className="text-center text-lg tracking-[0.5em] font-mono"
                    inputMode="numeric"
                  />
                  {totpError && <p className="text-xs text-red-400">{totpError}</p>}
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleTotpVerify} loading={totpLoading}>
                      Verify &amp; Enable
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => { setShowTotpSetup(false); setTotpCode(""); setTotpError(""); }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {me?.totp_enabled && !showTotpSetup && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-emerald-400">
                  <ShieldCheck className="h-4 w-4" />
                  Two-factor authentication is active
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={handleTotpSetup} loading={totpLoading}>
                    Reset 2FA
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={handleTotpDisable}
                    loading={disableLoading}
                  >
                    <ShieldOff className="h-3.5 w-3.5 mr-1.5" />
                    Disable 2FA
                  </Button>
                </div>
                {disableError && <p className="text-xs text-red-400">{disableError}</p>}
              </div>
            )}
          </CardContent>
        </Card>

        <ApiKeysCard />

        <div className="pt-2 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            ← Back
          </Button>
          <Button variant="destructive" size="sm" onClick={() => { logout(); navigate("/login"); }}>
            <LogOut className="h-3.5 w-3.5 mr-1.5" />
            Sign Out
          </Button>
        </div>
      </div>
    </Layout>
  );
}
