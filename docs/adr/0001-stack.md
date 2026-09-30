# ADR 0001: Technology stack

Status: proposed (2026-09-30)
Deciders: webapp owner

## Context

POD Studio is an internal multi-user webapp for designers, sellers and store leaders. It replaces the
single-operator tool described in `prd-rebuild.md` (TanStack Start + Postgres + pg-boss). The stack only
has to serve the webapp; AI workers and the skills runtime are separate services behind
`packages/contracts`.

Drivers, in order:

1. End-user UX quality: fast grids with hundreds of images, keyboard-driven review, live job status,
   polished components.
2. Mainstream and production-proven, so hiring, docs and AI coding help are easy.
3. SQL-first data layer that can express `FOR UPDATE SKIP LOCKED`, advisory locks and the PRD conventions
   (text nanoid PKs, no Postgres enums, `timestamptz`).
4. Few moving parts to operate on one host at first.

## Decision

| Concern | Choice | Version seen on npm 2026-09-30 |
|---|---|---|
| Web framework | Next.js App Router, React, TypeScript strict | next 16.3.7, react 19.3.0 |
| UI kit | Tailwind CSS v4 + shadcn/ui (Radix primitives), lucide-react icons | tailwindcss 4.3.3 |
| Motion, toasts, command palette | motion (sparingly), sonner, cmdk | motion 13.4.6, sonner 2.0.8, cmdk 1.1.1 |
| Tables and big grids | TanStack Table + TanStack Virtual | 9.2.4, 3.14.13 |
| Forms | react-hook-form + zod | 7.89.0 |
| Server state | Server Components for first paint, TanStack Query for live lists | @tanstack/react-query 5.104.0 |
| URL state | nuqs (filters, selected row, open drawer live in the URL) | 2.10.1 |
| Local UI state | zustand, only where state crosses components (review selection, upload queue) | 5.0.15 |
| Mutations | Server Actions that call `packages/core`; route handlers for the worker API and SSE | |
| Auth | better-auth: email + password, admin plugin, sessions in Postgres, public sign-up disabled | 1.7.6 |
| Database | Postgres 16 + Drizzle ORM + drizzle-kit migrations | drizzle-orm 0.45.3 |
| Internal background jobs | pg-boss in `apps/jobs` (push, reapers, notifications) | 12.35.0 |
| AI jobs | own lease table claimed over HTTP per `packages/contracts` (not pg-boss) | |
| Realtime | Server-Sent Events fed by Postgres `LISTEN/NOTIFY` | |
| Files | S3 API: MinIO in dev; MinIO or Cloudflare R2 in prod | |
| Tests | Vitest (unit, integration against real Postgres), Playwright + axe (E2E, a11y), contract tests | |
| Repo | pnpm workspaces monorepo | |

Weekly npm downloads measured the same day, as a rough adoption signal: next 70.0M,
@tanstack/react-start 20.0M, @tanstack/react-query 78.6M, zustand 65.5M, drizzle-orm 28.7M,
@prisma/client 19.2M, better-auth 11.1M, @preact/signals-react 0.35M.

## Alternatives considered

- **TanStack Start** (what the PRD used). Good type-safe routing and server functions. Rejected as the
  default only on driver 2: Next.js has the larger ecosystem, more production references and more
  examples for shadcn/ui, better-auth and Drizzle. Nothing in the PRD domain logic depends on it, because
  that logic moves to framework-free `packages/core`.
- **Prisma.** Fine ORM, but the job lease and scheduler need hand-written SQL (`SKIP LOCKED`, window
  functions for round-robin). Drizzle keeps that SQL in one typed layer and matches the PRD conventions.
- **Auth.js / Clerk / Lark or Google SSO.** SSO is out of scope (admin-created accounts and invite links).
  Hosted auth adds a vendor for an internal tool. better-auth gives email + password, admin user
  management, session revocation and bans in our own Postgres.
- **tRPC.** Server Actions plus a few route handlers cover the internal UI; the only external API is the
  worker API, which is specified in OpenAPI instead.

## Preact Signals evaluation

Checked `preactjs/signals` (packages/react README) and npm on 2026-09-30:

- `@preact/signals-react` 3.12.0 supports React 16.14 to 19.
- Automatic reactivity needs the Babel plugin `@preact/signals-react-transform`; without it every
  component that reads a signal must call `useSignals()`. Next.js compiles with SWC, so the plugin
  would add a Babel step to the build.
- Documented limits: signals cannot be passed as DOM attributes in the React integration, render props
  and object getters may not be tracked, and components rendered through React SSR APIs do not track
  signals.
- Adoption is about 0.35M weekly downloads, against about 65M for zustand.

Decision: **do not adopt now.** The performance-sensitive screens (review grid, design library, upload
queue) are handled with virtualization, memoized rows and zustand selectors, which re-render only the
rows whose slice changed. Revisit only if a React profiler trace shows a re-render bottleneck that
selectors cannot fix; if adopted then, confine `@preact/signals-core` to one leaf module and read it
through `useSignals()`, with no build-wide transform.

## Consequences

- One language (TypeScript) across web, jobs, core and contracts. The Python side (workers, niche skill
  validator) is reached only over HTTP or as a subprocess.
- `packages/core` must stay framework-free so PRD logic (pricing, SEO, push) can be ported and tested
  without Next.js.
- Server Actions must never be the only permission check: every action calls `packages/core`, which
  checks permissions itself.
