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
RUN npm run build -w packages/shared && npm run build -w apps/web

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
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
