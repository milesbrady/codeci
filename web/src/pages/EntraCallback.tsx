import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/auth";

// The backend sends us here as `/auth/entra/callback#token=<jwt>&user=<name>`.
// Reading from the URL fragment (instead of the query string) keeps the JWT
// out of server access logs and the Referer header. We immediately persist it
// into the auth store and replaceState the URL clean so a back-button press
// can't surface the token again.
export function EntraCallback() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  useEffect(() => {
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const token = params.get("token");
    const user = params.get("user") ?? "";

    if (!token) {
      navigate("/login?error=callback_failed", { replace: true });
      return;
    }

    setAuth(token, true, user);
    window.history.replaceState({}, "", "/dashboard");
    navigate("/dashboard", { replace: true });
  }, [navigate, setAuth]);

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="text-zinc-500 text-sm">Completing sign-in…</div>
    </div>
  );
}
