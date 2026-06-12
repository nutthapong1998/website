# Admin OAuth Login — Google Sign-In via Firebase Auth

Read this when building or modifying the admin login flow, the login page,
or anything under `app/api/auth/`. This builds on
[security.md](security.md) sections 2–3 (session cookies, custom claims) —
read those first; this file covers the OAuth-specific parts and does not
repeat them.

## The flow (end to end)

OAuth here means: Google is the identity provider, Firebase Auth brokers it,
and our server converts the result into the `__session` cookie that every
admin page and API checks.

```
[admin.example.com/login]
  1. user clicks "Sign in with Google"
  2. signInWithPopup(GoogleAuthProvider)          ← client SDK
  3. Google account chooser → back with ID token
  4. POST /api/auth/session { idToken }
  5. server: verifyIdToken → check role === 'admin'   ← the real gate
  6. createSessionCookie → Set-Cookie __session (httpOnly)
  7. redirect to /admin (admin layout re-verifies on every page)
```

The critical design point is step 5: **signing in with Google proves who the
user is, not that they're allowed in.** Any Gmail account on earth can
complete steps 1–4. Authorization is the `role: "admin"` custom claim
(set once via the `scripts/set-admin.ts` script in security.md §3) — the
session endpoint must refuse to mint a cookie for anyone without it.

## Firebase console setup (one-time)

1. Authentication → Sign-in method → enable **Google**.
2. Authentication → Settings → **Authorized domains**: add
   `admin.example.com` (and `localhost` is there by default). Forgetting
   this is the #1 cause of `auth/unauthorized-domain`.
3. No client secret handling needed — Firebase manages the Google OAuth
   client. (If the console asks for a support email, set it; the consent
   screen shows it.)

## Login page

```tsx
// src/app/admin/login/page.tsx  (rendered at admin.example.com/login)
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleLogin() {
    setError(null);
    try {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth, provider);
      const idToken = await cred.user.getIdToken();

      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken }),
      });

      if (!res.ok) {
        // not an admin (or session refused) — drop the client-side login too,
        // otherwise the browser keeps a signed-in Firebase user with no session
        await signOut(auth);
        setError("บัญชีนี้ไม่มีสิทธิ์เข้าถึงหน้า admin");
        return;
      }
      router.replace("/admin");
    } catch (e: any) {
      if (e.code === "auth/popup-blocked")
        setError("เบราว์เซอร์บล็อก popup — อนุญาต popup แล้วลองอีกครั้ง");
      else if (e.code !== "auth/popup-closed-by-user")
        setError("เข้าสู่ระบบไม่สำเร็จ ลองอีกครั้ง");
    }
  }

  return (
    <main>
      <h1>Admin</h1>
      <button onClick={handleLogin}>Sign in with Google</button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
```

Why `signInWithPopup` and not `signInWithRedirect`: redirect mode depends on
third-party storage between your domain and the Firebase `authDomain`, which
Safari/Chrome privacy features break on custom domains. Popup avoids the
whole class of problems. (If redirect mode is ever truly required — e.g.
in-app browsers that kill popups — the fix is proxying `/__/auth/*` to
`<project>.firebaseapp.com` via a rewrite and setting `authDomain` to your
own domain; treat that as the escalation path, not the default.)

## Hardening the session endpoint

Extend the `/api/auth/session` handler from security.md §2 with the
authorization gate — this is the difference between "OAuth login" and "open
door with extra steps":

```ts
const decoded = await getAuth().verifyIdToken(idToken);

// Authorization gate: identity ≠ permission
if (decoded.role !== "admin")
  return new Response("Forbidden", { status: 403 });
```

Bootstrap problem (first admin has no claim yet): sign in with Google once
so the Firebase user exists → run
`npx tsx scripts/set-admin.ts <your-email>` → sign in again (fresh token
carries the claim). Do NOT solve this with an email allowlist hardcoded in
the handler "temporarily" — temporary allowlists become permanent shadow
authz that drifts from the claims.

Also keep the login page itself reachable: the admin layout guard
(security.md §2) must exclude `/login`, e.g. place login outside the
guarded group (`app/admin/(protected)/layout.tsx` holds the guard;
`app/admin/login/page.tsx` sits beside it).

## Logout

```ts
await fetch("/api/auth/session", { method: "DELETE" }); // clears cookie
await signOut(auth);                                     // clears client state
router.replace("/login");
```

Both halves matter: cookie-only logout leaves the client SDK signed in (next
popup silently re-creates a session); client-only logout leaves a valid
week-long cookie behind.

## Interplay with the rest of the stack

- **Cloudflare Access** (security.md §8) sits in FRONT of all this: the user
  passes Access first, then Google OAuth. That's intentional
  defense-in-depth — Access keeps the login page itself off the public
  internet; Firebase Auth + claims decide what the app trusts. Don't remove
  one because the other exists. (Access can also use Google as its IdP, so
  in practice the user sees one Google prompt and one click.)
- **CSP** (security.md §6): the popup flow needs
  `frame-src https://*.firebaseapp.com` (already in the template) — if the
  popup opens then blanks out, check the CSP before anything else.
- **Local dev**: `localhost` is pre-authorized; with the Auth emulator,
  Google sign-in is simulated (any email works) — convenient, but remember
  the emulator never sets your custom claims unless you set them in the
  emulator too.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `auth/unauthorized-domain` | Domain not in Authorized domains | Add `admin.example.com` in Firebase console |
| Popup opens and immediately closes/blank | CSP missing `frame-src` for firebaseapp.com | Fix CSP, don't disable it |
| Login succeeds but `/admin` bounces back to `/login` | Session cookie not set (403 from endpoint, or `secure` cookie over http) | Check the user has the admin claim; locally use http→`secure:false` only in dev |
| Works as you, 403 for a teammate | They have no `role: admin` claim | `scripts/set-admin.ts <email>`, then they re-login |
| Claim added but still 403 | Old ID token cached (≤1h) | `getIdToken(true)` or sign out/in |
| Redirect-mode login loops forever | Third-party storage partitioning on custom domain | Use popup mode (default here) |
