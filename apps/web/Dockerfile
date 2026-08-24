# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# `npm ci` (not install): strict lockfile replay — faster, and the image can never quietly
# resolve different versions than the repo tested. The BuildKit cache mount persists the npm
# cache BETWEEN builds without ever entering the image, cutting rebuild times dramatically.
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev --no-audit --no-fund
# vite.config.ts bakes the repo-root VERSION into the bundle (__APP_VERSION__); without this
# COPY a Docker build would fall back to "0.0.0-dev" and the update-refresh prompt would never
# fire for anyone served from this image.
COPY VERSION ./
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# `VITE_API_URL` is baked in at BUILD time, not read at runtime — Vite substitutes
# `import.meta.env` into the bundle, so there is no way to change it later with a container env var.
# It defaults to "/api" (same origin), which is correct for every shape this repo ships: both compose
# files and the Helm chart put nginx in front and proxy /api to the API service. Only a SPLIT
# deployment — the SPA on a CDN or a different hostname from the API — needs it, and that deployment
# has to pass it here as a build arg and rebuild the image:
#   docker build -f apps/web/Dockerfile --build-arg VITE_API_URL=https://api.example.com/api .
# The `predev`/`prebuild` hook in apps/web/package.json also runs here, copying the two Human face
# models the browser needs into the bundle — which is why the built web image can serve
# /human-models/blazeface.json, and why install.sh and update.sh probe that path as a build check.
#
# The `unset` is not defensive noise — it is required. api.ts reads
# `import.meta.env.VITE_API_URL ?? "/api"`, and `??` only falls back on null/undefined, NOT on an
# empty string. If this build arg reached Vite as "" the bundle would be compiled with an empty API
# base and every request in the app would resolve against the wrong path. So an unsupplied arg is
# removed from the environment entirely rather than passed through as "", which is what keeps the
# default same-origin "/api" behaviour intact for the builds that do not set it.
ARG VITE_API_URL
RUN if [ -z "${VITE_API_URL:-}" ]; then unset VITE_API_URL; fi; \
    npm run build -w packages/shared && npm run build -w apps/web

FROM nginx:1.27-alpine
# A TEMPLATE, not a finished conf: the stock nginx entrypoint's 20-envsubst-on-templates.sh
# renders /etc/nginx/templates/*.template into conf.d at startup, substituting ${API_UPSTREAM}.
# The old hardcoded `proxy_pass http://api:4000` was the compose service name baked into the
# image — under Kubernetes no service called `api` exists, nginx failed upstream resolution at
# startup, and the web pod crash-looped with nothing in its logs past "ready for start up".
# The ENV below keeps compose working with zero configuration; the Helm chart overrides it with
# the release's real API service name.
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV API_UPSTREAM=api:4000
# Extra origins appended to the SPA's `connect-src` CSP directive. MUST be declared here even
# though it is empty by default: the entrypoint's envsubst pass only substitutes variables that
# exist in the environment, so an undeclared `${CSP_CONNECT_SRC}` would be left in the rendered
# conf VERBATIM — and nginx refuses to start on a malformed header value, crash-looping the web
# container. Empty is the correct default: every topology this repo ships puts the API behind the
# same nginx, so 'self' already covers it. Set it only for a SPLIT deployment, to the same origin
# passed as VITE_API_URL above, e.g. CSP_CONNECT_SRC="https://api.example.com".
ENV CSP_CONNECT_SRC=""
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
