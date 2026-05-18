import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { authApi, configApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useAppConfigStore } from "@/store/appConfig";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Zap } from "lucide-react";

const loginSchema = z.object({
  username: z.string().min(1, "Username required"),
  password: z.string().min(1, "Password required"),
});

const registerSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirm: z.string().min(1, "Please confirm your password"),
}).refine((d) => d.password === d.confirm, {
  message: "Passwords do not match",
  path: ["confirm"],
});

type LoginData = z.infer<typeof loginSchema>;
type RegisterData = z.infer<typeof registerSchema>;

// Map server-side error codes from /api/auth/entra/callback to user-facing copy.
const entraErrorMessages: Record<string, string> = {
  not_registered: "This Microsoft account is not registered. Contact your administrator.",
  state_mismatch: "Sign-in attempt expired. Please try again.",
  state_invalid: "Sign-in security check failed. Please try again.",
  wrong_tenant: "Account is from a different Microsoft tenant.",
  no_email_claim: "Microsoft did not return an email address for this account.",
  config_error: "Microsoft sign-in is not configured correctly.",
  provider_error: "Microsoft rejected the sign-in request.",
  provider_unreachable: "Could not reach Microsoft. Try again in a moment.",
  token_exchange_failed: "Microsoft sign-in failed (token exchange).",
  missing_id_token: "Microsoft sign-in failed (missing ID token).",
  id_token_invalid: "Microsoft sign-in failed (token verification).",
  claims_parse_failed: "Microsoft sign-in failed (claims parse).",
  missing_code: "Microsoft sign-in was cancelled.",
  token_sign_failed: "Sign-in succeeded but token issuance failed. Try again.",
  callback_failed: "Sign-in callback failed. Please try again.",
};

export function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { setAuth, setMustChangePassword } = useAuthStore();
  const appName = useAppConfigStore((s) => s.name);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);
  const [entraEnabled, setEntraEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    configApi.getAuth()
      .then((res) => {
        setRegistrationOpen(res.data.registration_open);
        setEntraEnabled(res.data.entra_enabled);
      })
      .catch(() => {
        setRegistrationOpen(false);
        setEntraEnabled(false);
      });
  }, []);

  useEffect(() => {
    if (params.get("expired") === "1") {
      setNotice("Your session has expired. Please sign in again.");
    }
    const errCode = params.get("error");
    if (errCode) {
      setError(entraErrorMessages[errCode] ?? "Sign-in failed. Please try again.");
    }
  }, [params]);

  const loginForm = useForm<LoginData>({ resolver: zodResolver(loginSchema) });
  const registerForm = useForm<RegisterData>({ resolver: zodResolver(registerSchema) });

  async function onLogin(data: LoginData) {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await authApi.login(data.username, data.password);
      const { token, totp_enabled, must_change_password } = res.data;
      if (totp_enabled) {
        setAuth(token, false, data.username);
        navigate("/totp/verify");
      } else {
        setAuth(token, true, data.username);
        if (must_change_password) {
          setMustChangePassword(true);
          navigate("/profile");
        } else {
          navigate("/dashboard");
        }
      }
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      setError(msg && typeof msg === "string" && msg !== "" ? msg : "Invalid username or password.");
    } finally {
      setLoading(false);
    }
  }

  async function onRegister(data: RegisterData) {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      await authApi.register(data.username, data.password);
      // Auto-login after registration
      const res = await authApi.login(data.username, data.password);
      const { token, totp_enabled } = res.data;
      setAuth(token, !totp_enabled, data.username);
      navigate(totp_enabled ? "/totp/verify" : "/dashboard");
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Registration failed.");
    } finally {
      setLoading(false);
    }
  }

  if (registrationOpen === null) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-600 mb-4">
            <Zap className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-zinc-100 text-center">{appName}</h1>
          <p className="text-sm text-zinc-400 mt-1">
            {registrationOpen ? "Create your admin account" : "Sign in to your account"}
          </p>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-5">
          {notice && (
            <div className="rounded-lg bg-amber-950/50 border border-amber-800 px-3 py-2 text-sm text-amber-300">
              {notice}
            </div>
          )}
          {registrationOpen ? (
            <form onSubmit={registerForm.handleSubmit(onRegister)} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-zinc-300">Username</label>
                <Input placeholder="admin" autoComplete="username" {...registerForm.register("username")} />
                {registerForm.formState.errors.username && (
                  <p className="text-xs text-red-400">{registerForm.formState.errors.username.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-zinc-300">Password</label>
                <Input type="password" placeholder="••••••••" autoComplete="new-password" {...registerForm.register("password")} />
                {registerForm.formState.errors.password && (
                  <p className="text-xs text-red-400">{registerForm.formState.errors.password.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-zinc-300">Confirm Password</label>
                <Input type="password" placeholder="••••••••" autoComplete="new-password" {...registerForm.register("confirm")} />
                {registerForm.formState.errors.confirm && (
                  <p className="text-xs text-red-400">{registerForm.formState.errors.confirm.message}</p>
                )}
              </div>
              {error && (
                <div className="rounded-lg bg-red-950/50 border border-red-800 px-3 py-2 text-sm text-red-400">
                  {error}
                </div>
              )}
              <Button type="submit" className="w-full" size="lg" loading={loading}>
                Create account
              </Button>
            </form>
          ) : (
            <>
              <form onSubmit={loginForm.handleSubmit(onLogin)} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-zinc-300">Username</label>
                  <Input placeholder="admin" autoComplete="username" {...loginForm.register("username")} />
                  {loginForm.formState.errors.username && (
                    <p className="text-xs text-red-400">{loginForm.formState.errors.username.message}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-zinc-300">Password</label>
                  <Input type="password" placeholder="••••••••" autoComplete="current-password" {...loginForm.register("password")} />
                  {loginForm.formState.errors.password && (
                    <p className="text-xs text-red-400">{loginForm.formState.errors.password.message}</p>
                  )}
                </div>
                {error && (
                  <div className="rounded-lg bg-red-950/50 border border-red-800 px-3 py-2 text-sm text-red-400">
                    {error}
                  </div>
                )}
                <Button type="submit" className="w-full" size="lg" loading={loading}>
                  Sign in
                </Button>
              </form>

              {entraEnabled && (
                <>
                  <div className="flex items-center gap-3 text-xs text-zinc-500">
                    <div className="h-px flex-1 bg-zinc-800" />
                    <span>OR</span>
                    <div className="h-px flex-1 bg-zinc-800" />
                  </div>
                  <a
                    href="/api/auth/entra/login"
                    className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 text-sm font-medium text-zinc-100 transition hover:bg-zinc-800"
                  >
                    <MicrosoftLogo />
                    Sign in with Microsoft
                  </a>
                </>
              )}
            </>
          )}
        </div>

        <p className="text-center text-xs text-zinc-600 mt-6">
          {registrationOpen
            ? "First-time setup · This account will have admin access"
            : entraEnabled
            ? "Protected by TOTP 2FA or Microsoft Entra ID"
            : "Protected by TOTP 2FA · Basic Auth mode"}
        </p>
      </div>
    </div>
  );
}

function MicrosoftLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="1" y="1" width="10" height="10" fill="#f25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
      <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
      <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
    </svg>
  );
}
