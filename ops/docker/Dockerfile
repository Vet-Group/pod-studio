# syntax=docker/dockerfile:1.7
# Production image for the POD Studio web app.
#
#   docker build -f ops/docker/Dockerfile -t pod-studio-web:<tag> .
#
# The image runs the Next.js standalone server (apps/web/server.js) as the unprivileged `node`
# user and also carries two bundled operator tools:
#   node tools/migrate.mjs                                  apply pending database migrations
#   node tools/create-admin.mjs --email <e> --name <n>      create the first admin (fresh install)
# Both read DATABASE_URL (or the standard PG* variables). See docs/deploy.md.

ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_store_dir=/pnpm/store \
    CI=true
# Same pnpm as package.json#packageManager.
RUN npm install --global --no-fund --no-audit pnpm@12.5.1
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @pod-studio/web build
# Operator tools: one self-contained ESM file each, so the runtime image needs no tsx or pnpm.
# The require shim lets bundled CommonJS dependencies load inside an ES module.
RUN for entry in packages/db/src/cli/migrate.ts packages/core/src/cli/create-admin.ts; do \
      pnpm exec esbuild "$entry" --bundle --platform=node --format=esm --target=node24 \
        --outdir=/out/tools --out-extension:.js=.mjs --log-level=warning \
        --banner:js="import { createRequire as __podCreateRequire } from 'node:module'; const require = __podCreateRequire(import.meta.url);" \
      || exit 1; \
    done \
 && cp -r packages/db/migrations /out/migrations

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# Standalone output keeps the monorepo layout: apps/web/server.js plus the traced node_modules.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
# tools/migrate.mjs resolves its migrations folder as ../migrations, i.e. /app/migrations.
COPY --from=build --chown=node:node /out/tools ./tools
COPY --from=build --chown=node:node /out/migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "apps/web/server.js"]
