# Design Guide — Personal Profile / Portfolio Website

Read this before creating or restyling any page under `app/(site)/`. The goal
of a profile site is singular: a visitor (recruiter, client, colleague)
decides within ~10 seconds whether this person is credible and how to contact
them. Every design decision below serves that.

## Page architecture

A profile site is one scrolling page plus optional detail pages — not a
sprawling multi-page site:

```
/                  hero → highlights → about → experience/projects → contact
/projects/[slug]   (optional) case-study detail pages
/blog, /blog/[slug] (optional, only if the owner will actually write)
```

Section order and what each must do:

1. **Hero** — name, one-line value proposition ("ตำแหน่ง + ความเชี่ยวชาญ +
   สิ่งที่กำลังทำ"), photo, and ONE primary CTA (ดู resume / ติดต่อ). No
   carousels, no animated typing of three job titles — pick the strongest one.
2. **Highlights / skills** — scannable, grouped (e.g. Languages / Cloud /
   Data), max ~12 items. A wall of 40 logos signals the opposite of expertise.
3. **Experience or selected projects** — 3–5 entries max, each with: what it
   was, the owner's specific role, and a concrete outcome (number, scale,
   result). "Built X serving Y users" beats a paragraph of responsibilities.
4. **About** — 2–3 sentences of personality. Written in first person.
5. **Contact / footer** — email, GitHub, LinkedIn. Email as `mailto:` or a
   form (form goes through `/api/public/contact` with zod + rate limit per
   the security playbook).

## Visual system — decide once, in tokens

Define everything as CSS variables (or Tailwind theme config) before building
components; ad-hoc values are how a site drifts into looking amateur:

```css
:root {
  /* Color: ONE accent on a neutral base. */
  --background: #0a0a0a;        /* or near-white for light theme */
  --foreground: #ededed;
  --muted: #a3a3a3;
  --accent: #38bdf8;            /* links, CTA, focus rings — nothing else */
  --surface: #171717;           /* cards */
  --border: #262626;

  /* Type scale: ratio-based (1.25), not eyeballed */
  --text-sm: 0.875rem;
  --text-base: 1rem;            /* body — never smaller than 16px */
  --text-lg: 1.25rem;
  --text-xl: 1.5625rem;
  --text-2xl: 1.953rem;
  --text-3xl: 2.441rem;         /* hero name */

  /* Spacing: 4px grid — only multiples of 4 (8/12/16/24/32/48/64/96) */
  --space-section: 6rem;        /* between sections; generous = premium */
}
```

Rules that follow from the tokens:

- **One accent color.** Profile sites die by rainbow. Accent goes on links,
  the CTA, and focus states; everything else is the neutral scale.
- **Two fonts max** via `next/font` (zero layout shift, self-hosted
  automatically): one for headings, one for body — or just one family in two
  weights. For Thai content pick a font with proper Thai support
  (e.g. IBM Plex Sans Thai, Noto Sans Thai, Anuphan) and set it for both
  Thai and Latin to avoid mismatched baselines.
- **Line length** 60–75 characters (`max-width: 65ch` on prose), line-height
  1.6–1.7 for body, 1.1–1.2 for headings.
- **Whitespace is the design.** When a section looks wrong, the fix is almost
  always more space, not more decoration. `--space-section` between sections,
  consistent gaps inside.
- **Dark/light**: support `prefers-color-scheme` via the variables above. If
  offering a toggle, persist it and apply before first paint (inline script
  in layout) to avoid the flash.

## Imagery & motion

- All images through `next/image` with explicit `width`/`height` (no layout
  shift) and `priority` ONLY on the hero image (it's the LCP element).
- Profile photo: real, recent, decent lighting, consistent treatment
  (same border radius as cards). Project images: real screenshots over stock.
- Motion: subtle and purposeful — a 150–250ms ease on hover, optional
  fade-up on scroll for sections. Honor `prefers-reduced-motion`. Nothing
  loops infinitely; nothing animates on the critical path to reading content.

## Performance budget (this site has zero excuse to be slow)

A mostly-static profile site should score 95+ on Lighthouse mobile. Budget:

- LCP < 2.0s, CLS < 0.05, total JS < 150KB gzipped.
- Pages under `(site)` are static — no `firebase` client SDK import on the
  public site unless a feature truly needs live data (it almost never does;
  fetch via Admin SDK in Server Components at build/request time instead).
  The client Firestore bundle alone can double the JS budget.
- `"use client"` only at the leaves (theme toggle, mobile menu, contact
  form) — never on whole sections.
- Verify before claiming done: `npm run build` shows route sizes; check the
  First Load JS column, and run Lighthouse on the deployed URL.

## SEO & sharing

Use the Metadata API in the root layout — a profile site's whole purpose is
being found by name:

```ts
export const metadata: Metadata = {
  metadataBase: new URL("https://www.example.com"),
  title: { default: "ชื่อ-นามสกุล — ตำแหน่ง", template: "%s — ชื่อ" },
  description: "One sentence: who, what, where.", // ≤155 chars
  openGraph: { type: "profile", images: ["/og.png"] }, // 1200×630
};
```

- Add JSON-LD `Person` schema (name, jobTitle, sameAs: [GitHub, LinkedIn])
  in the home page — this is what makes the Google knowledge panel possible.
- `app/sitemap.ts` and `app/robots.ts` (both are ~5 lines in App Router).
- One `<h1>` per page (the name in the hero), sections use `<h2>`.
- The admin subdomain must NOT be indexed: it's already behind Cloudflare
  Access, but also return `X-Robots-Tag: noindex` for `admin.*` hosts.

## Accessibility (non-negotiable minimum)

- Semantic landmarks: `<header> <nav> <main> <section> <footer>` — divs are
  not structure.
- Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text. Muted-gray-on-gray
  aesthetics routinely fail this — check with a contrast tool, don't eyeball.
- Every interactive element keyboard-reachable with a visible focus ring
  (style `:focus-visible` with the accent color; never `outline: none`
  without a replacement).
- `alt` text on meaningful images; `alt=""` on decorative ones.
- Form inputs have `<label>`s; errors are text, not just red borders.

## Content tone (the part design can't fix)

- First person, active voice, concrete: "ผมสร้างระบบ X ที่รองรับผู้ใช้ Y คน"
  over "มีความรับผิดชอบเกี่ยวกับ...".
- Numbers and outcomes wherever truthful. Cut every buzzword that could
  appear on anyone's site ("passionate", "detail-oriented") — if everyone
  can claim it, it carries no information.
- Bilingual (TH/EN): pick the primary audience's language for the main flow;
  don't half-translate. If both matter, EN primary with a Thai section (or
  i18n routing) beats mixed paragraphs.
