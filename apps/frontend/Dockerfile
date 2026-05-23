# syntax=docker/dockerfile:1.7
#
# Frontend image. nginx serves the Vite-built SPA over plain HTTP; same-origin
# /api/* is proxied to the backend container internally. The external reverse
# proxy (Traefik in dev, deployer's proxy in prod) terminates TLS — nothing in
# this image touches certificates.
#
# Build context is the repo root (compose sets `context: .`) because pnpm's
# workspace install needs the root manifests + lockfile.

# ─── build ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
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

COPY tsconfig.base.json ./
COPY apps/frontend apps/frontend

# Bake same-origin routing into the bundle. `client.ts` reads
# `import.meta.env.VITE_API_BASE_URL ?? ''`, so an empty value resolves every
# `/api/*` call to the page's own origin — which nginx (below) proxies to the
# backend container.
ENV VITE_API_BASE_URL=""
# Contact email shown in the page footer. Passed at build time because Vite
# bakes `import.meta.env.VITE_*` into the bundle. Empty by default — the
# footer simply hides the contact link when unset. Compose interpolates
# this from the host shell / `.env`; production builds set it explicitly.
ARG VITE_CONTACT_EMAIL=""
ENV VITE_CONTACT_EMAIL=$VITE_CONTACT_EMAIL
RUN pnpm --filter @bbstat/frontend build

# ─── runtime ────────────────────────────────────────────────────────────────
# Unprivileged nginx variant: listens on 8080 (no CAP_NET_BIND_SERVICE needed)
# and runs as uid 101.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY --chown=nginx:nginx apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /repo/apps/frontend/dist /usr/share/nginx/html

EXPOSE 8080
