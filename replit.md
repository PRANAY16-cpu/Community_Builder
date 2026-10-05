# Community Builder

A mobile-first community app that turns developer discussions into searchable shared memory and answers new questions with citations to past conversations.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/community-builder run dev` — run the Community Builder web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Replit provides `DATABASE_URL` for PostgreSQL. Optional `GROQ_API_KEY` enables LLM extraction and answer generation; see `.env.example`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/community-builder` — mobile-first React/Vite app
- `artifacts/api-server/src/routes/community.ts` — feed, create-post, Ask, and memory API
- `artifacts/api-server/src/lib/community-ai.ts` — Groq extraction, query understanding, grounded answers, and safe fallbacks
- `lib/db/src/schema` — PostgreSQL discussion and memory tables
- `lib/api-spec/openapi.yaml` — source API contract; regenerate client and validation schemas after edits

## Architecture decisions

- Uses the project's Replit-managed PostgreSQL instead of requiring a separate Supabase project; API persistence is available without additional setup.
- Uses keyword retrieval over community posts for the MVP; retrieved posts are always returned as citations.
- Groq is optional at runtime. When unavailable, the app saves posts with conservative fallback extraction and returns retrieved excerpts without inventing an answer.

## Product

- Searchable community feed, post creation with automatic memory updates, a cited community Q&A assistant, and accumulated topic memory.
- Bottom navigation for Home, Ask, Memory, and a minimal profile surface.

## User preferences

- Keep the hackathon MVP focused; avoid advanced features outside the brief.

## Gotchas

- `GROQ_API_KEY` is server-side only. Never expose it through a `NEXT_PUBLIC_` variable.
- API requests use the `/api` path through the shared workspace proxy.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
