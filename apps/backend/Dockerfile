# syntax=docker/dockerfile:1.7
#
# Backend image. One image serves all three backend roles:
#   • API server     — default CMD              → dist/index.js
#   • sync runner    — compose `command:` override → dist/sync/index.js
#   • migrate one-shot — compose `command:` override → dist/scripts/migrate.js
#
# Build context is the repo root (compose.yaml sets `context: .`) because pnpm's
# workspace install needs the root manifests + lockfile.
#
# Runtime is gcr.io/distroless/nodejs22-debian12 (nonroot variant). No shell, no
# package manager, no curl — container health probes do their work from the
# compose side via `wget` in a sidecar or use a node-native script if needed.

# ─── deps ───────────────────────────────────────────────────────────────────
# Full workspace install (incl. devDeps) so we can typecheck + build. Cached
# by the COPY of just the manifests, so source edits don't re-trigger install.
FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─── build ──────────────────────────────────────────────────────────────────
# Compile TS → dist/ (flat: dist/index.js, dist/sync/index.js, dist/scripts/migrate.js).
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/backend apps/backend
RUN pnpm --filter @bbstat/backend build

# ─── prod-deploy ────────────────────────────────────────────────────────────
# `pnpm deploy --prod` bundles backend's runtime deps into a self-contained
# directory with no workspace symlinks and no devDeps. Distroless can run
# straight out of it.
FROM deps AS prod-deploy
COPY apps/backend apps/backend
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @bbstat/backend deploy --prod --legacy /deploy

# ─── runtime ────────────────────────────────────────────────────────────────
# Distroless nonroot: runs as uid 65532. Files copied below are world-readable
# by default, so no chown needed.
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

COPY --from=prod-deploy /deploy/node_modules ./node_modules
COPY --from=prod-deploy /deploy/package.json ./package.json
COPY --from=build /repo/apps/backend/dist ./dist
# Migration SQL must sit alongside dist/ so scripts/migrate.js can resolve
# `<dist>/../drizzle` consistently between dev (tsx) and runtime layouts.
COPY --from=build /repo/apps/backend/drizzle ./drizzle

ENV NODE_ENV=production \
    BACKEND_HOST=0.0.0.0 \
    BACKEND_PORT=8080 \
    BACKEND_TLS=off
EXPOSE 8080

# Default role is the API server. compose overrides `command:` for the sync
# and migrate services.
CMD ["dist/index.js"]
