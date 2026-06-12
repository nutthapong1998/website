# Content Management — Admin edits, public site renders

Read this when building admin features that create/edit content shown on the
main website (profile text, projects, experience, images), or when wiring
the public site to read that content. It extends the security playbook
([security.md](security.md)) — every pattern here assumes the guards, zod
validation, and "all writes through the API" policy from there.

The mental model: **the admin app is a tiny private CMS; the public site is
a mostly-static renderer of what the CMS saved.** Keeping those roles strict
is what keeps the public site fast (no client SDK, no live queries) and the
attack surface small (public site never writes anything).

```
admin UI ──POST/PUT──► /api/admin/* (guard + zod + Admin SDK)
                            │ writes
                            ▼
                        Firestore + Cloud Storage
                            │ reads (Admin SDK, server-side)
                            ▼
              public pages (Server Components, ISR)
                  ▲ revalidatePath() after every admin write
```

## Firestore content model

A profile site's content is small — model it for easy editing, not for scale:

```
site/profile        ← singleton doc: name, headline, bio, photoUrl, socials{}
site/settings       ← singleton doc: theme, locale, contact email
projects/{id}       ← title, summary, body, imageUrl, tags[], order,
                      published, createdAt, updatedAt
experience/{id}     ← role, company, period, description, order, published
```

Conventions that prevent recurring pain:

- **Singleton docs** (`site/profile`) for one-of-a-kind content — fetching
  one known doc is simpler and cheaper than querying a collection of one.
- **`published` flag on everything listable.** Admin sees all; the public
  site queries `where("published", "==", true)`. Draft/preview comes free.
- **Explicit `order` field** (a number) for anything the owner will want to
  rearrange — sorting by `createdAt` always disappoints later. When
  reordering, write order values spaced by 10 (10, 20, 30…) so inserts
  don't cascade rewrites.
- Store **paths/URLs to images, never binary data**, in Firestore (1MB doc
  limit, and Storage is the right tool).

Zod schemas for each type live in `lib/validation/` (shared by the admin
form and the API handler, per SKILL.md structure).

## Image upload

All uploads go through a guarded route handler — consistent with the
"writes through the API" policy, and it keeps Storage rules irrelevant
(client never touches Storage directly).

```ts
// src/app/api/admin/upload/route.ts
import { randomUUID } from "crypto";
import { requireAdmin } from "@/lib/auth/guards";
import { getStorage } from "firebase-admin/storage";
import "@/lib/firebase/admin";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

export async function POST(req: Request) {
  try {
    await requireAdmin();

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return new Response("No file", { status: 400 });
    if (file.size > MAX_BYTES) return new Response("Too large (max 5MB)", { status: 413 });

    const ext = ALLOWED[file.type as keyof typeof ALLOWED];
    if (!ext) return new Response("Only JPEG/PNG/WebP", { status: 415 });

    // Never use the client's filename — it's attacker-controlled input
    // (path traversal, weird unicode, collisions). UUID + validated ext only.
    const path = `uploads/${randomUUID()}.${ext}`;
    const bucket = getStorage().bucket(process.env.FIREBASE_STORAGE_BUCKET);

    await bucket.file(path).save(Buffer.from(await file.arrayBuffer()), {
      contentType: file.type,
      metadata: { cacheControl: "public, max-age=31536000, immutable" },
    });
    await bucket.file(path).makePublic();

    return Response.json({
      url: `https://storage.googleapis.com/${bucket.name}/${path}`,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error(e);
    return new Response("Upload failed", { status: 500 });
  }
}
```

Supporting config:

- Env: `FIREBASE_STORAGE_BUCKET=<project-id>.appspot.com` (add to
  `.env.example` + README table in the same commit, per the secrets/readme
  rules). The Cloud Run service account needs `roles/storage.objectAdmin`
  on that bucket.
- `next.config.ts` must allow the host for `next/image`:

  ```ts
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "storage.googleapis.com", pathname: "/<bucket-name>/**" },
    ],
  },
  ```

- `immutable` caching is safe because filenames are UUIDs — replacing an
  image means uploading a new file and updating the URL in Firestore, never
  overwriting in place (overwriting + long cache = users see stale images
  for a year).
- Resize/compress before display is `next/image`'s job — don't add a sharp
  pipeline until a real need appears (e.g. >5MB originals from a camera;
  then raise the limit and resize server-side at upload).
- Orphan files (image uploaded, form never saved) are harmless clutter at
  this scale; if it ever matters, add a Storage lifecycle rule on
  `uploads/` for objects not referenced in 30 days — don't build cleanup
  machinery up front.

## CRUD route handlers

One resource = one file pair, all following the same skeleton (guard →
validate → act → **revalidate**):

```
app/api/admin/profile/route.ts        PUT (singleton update)
app/api/admin/projects/route.ts       GET (list incl. drafts), POST
app/api/admin/projects/[id]/route.ts  PUT, DELETE
```

```ts
// PUT /api/admin/profile — the singleton pattern
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { profileSchema } from "@/lib/validation/profile";
import { adminDb } from "@/lib/firebase/admin";

export async function PUT(req: Request) {
  try {
    await requireAdmin();
    const data = profileSchema.parse(await req.json());
    await adminDb.doc("site/profile").set(
      { ...data, updatedAt: new Date() },
      { merge: true },
    );
    revalidatePath("/");          // ← the public page updates NOW, not "eventually"
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof Error && e.name === "ZodError")
      return Response.json({ error: "Invalid input" }, { status: 400 });
    console.error(e);
    return new Response("Internal error", { status: 500 });
  }
}
```

**`revalidatePath` after every successful write is not optional.** Without
it, the admin saves, opens the site, sees old content, assumes the save
failed, and "fixes" it again. Revalidate every public path that renders the
touched data (`/` always; `/projects/[slug]` for project edits).

## Public site reads

Server Components + Admin SDK + ISR. No `firebase` client SDK on the public
site (per the design guide's performance budget):

```ts
// src/app/(site)/page.tsx
import { adminDb } from "@/lib/firebase/admin";

export const revalidate = 3600; // safety net; real freshness comes from revalidatePath

export default async function HomePage() {
  const [profileSnap, projectsSnap] = await Promise.all([
    adminDb.doc("site/profile").get(),
    adminDb.collection("projects")
      .where("published", "==", true)
      .orderBy("order")
      .get(),
  ]);
  const profile = profileSnap.data();
  const projects = projectsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // render…
}
```

- `revalidate = 3600` is the backstop (e.g. content edited directly in the
  Firebase console bypasses revalidatePath); on-demand revalidation does the
  real work.
- Composite query (`where` + `orderBy` on different fields) needs a
  Firestore index — the first run logs an error with a creation link;
  follow it, don't hand-craft the index JSON.
- Render defensively on first deploy: `site/profile` may not exist yet —
  fall back to placeholders instead of crashing, so the site deploys before
  the content does.

## Admin UI pattern

Keep admin forms boring and uniform — one pattern repeated per resource:

- Client component form + `zodResolver` using the **same schema** as the API.
- Image fields: upload first (`/api/admin/upload`), put the returned URL in
  the form state, show a preview with `next/image`; the content save then
  carries only the URL.
- After save: `router.refresh()` so admin lists/server components reflect
  the write; show an explicit success/error state — silent saves erode
  trust in the tool fast.
- Lists show drafts with a visible "draft" badge, ordered by `order`, with
  publish/unpublish as a one-click toggle (PUT with `{ published }`).

## Checklist for any new content type

- [ ] Zod schema in `lib/validation/`, `.strict()`, shared by form + API
- [ ] Handlers follow guard → validate → act → `revalidatePath`
- [ ] Public query filters `published == true`; admin list shows all
- [ ] `order` field if the owner will ever reorder it
- [ ] Images: through `/api/admin/upload`, URL stored in Firestore,
      `remotePatterns` covers the host
- [ ] Public page renders with the doc missing (placeholders, no crash)
- [ ] Verified end-to-end: edit in admin → public page shows it (curl or
      browser), not just "API returned 204"
