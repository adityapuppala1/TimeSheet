# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# `npm ci` (not install): strict lockfile replay — faster, and the image can never quietly
# resolve different versions than the repo tested. The BuildKit cache mount persists the npm
# cache BETWEEN builds without ever entering the image, cutting rebuild times dramatically.
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev --no-audit --no-fund

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma \
 && npx prisma generate --schema=apps/api/prisma/control/schema.prisma \
 && npm run build -w packages/shared \
 && npm run build -w apps/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The image carries its own identity: there is no .git inside a container, so the SHA and build
# date must be stamped in at build time (CD passes them as build-args; a local `docker build`
# without them still gets the VERSION file's semver via the COPY below). Read by
# src/config/version.ts, surfaced on /api/health and /api/system/version, and checked by
# update.sh to prove an upgrade actually landed.
ARG GIT_SHA=""
ARG BUILD_DATE=""
ENV GIT_SHA=$GIT_SHA
ENV BUILD_DATE=$BUILD_DATE
# Run as an unprivileged user rather than the container default root — defense-in-depth so a
# compromised dependency/RCE doesn't get root inside the container. --chown on every COPY below
# means the app user (not root) owns its own files; /app/uploads is created + chowned here too
# so the ownership is already correct before docker-compose.yml's api-uploads volume mounts over
# it (Docker seeds a fresh named volume from whatever's at that path in the image at mount time).
RUN addgroup -S app && adduser -S app -G app
COPY --chown=app:app VERSION ./
# The What's-new page's offline release history — parsed by changelog-releases.service.ts when
# GitHub has nothing to offer (private repo, air-gapped install, no releases published).
COPY --chown=app:app CHANGELOG.md ./
COPY --from=build --chown=app:app /app/node_modules node_modules
COPY --from=build --chown=app:app /app/apps/api/dist apps/api/dist
COPY --from=build --chown=app:app /app/apps/api/prisma apps/api/prisma
# The control-plane Prisma client is plain generated JS (not compiled by tsc), so it isn't
# under apps/api/dist on its own — copy it to the exact path config/control-prisma.js's
# compiled relative import (`../generated/control-client/index.js`) expects to find it at.
COPY --from=build --chown=app:app /app/apps/api/src/generated apps/api/dist/src/generated
# The SOURCE tree rides along too, and this line is load-bearing for every documented seed:
# `npm run seed` / `npm run control:seed` invoke tsx against prisma/*.ts, whose imports fan out
# through src/services and src/generated — paths that only existed compiled under dist/ in this
# image. Without src/, BOTH deployment paths' one-time seeds failed identically: install.sh's
# `docker compose exec api npm run control:seed` (whose retry loop then mislabeled the failure
# "often already-seeded, safe to ignore") and docs/DEPLOYMENT.md's kubectl-exec equivalents.
# Found by running the documented Kubernetes seed on a live cluster. ~3MB of TypeScript buys
# every runbook command working exactly as written.
COPY --from=build --chown=app:app /app/apps/api/src apps/api/src
# And the operational scripts, for the same reason one line up — except these were MISSING, and
# two commands the runbooks call routinely could therefore never have worked inside a container:
#
#   npm run migrate:tenants -w apps/api   → tsx scripts/migrate-all-tenants.ts
#   npm run doctor:heal     -w apps/api   → tsx scripts/doctor.ts --heal
#
# The first is the multi-org schema fan-out that update.sh runs through `docker compose exec` on
# EVERY update, and that docs/DEPLOYMENT.md tells Kubernetes operators to `kubectl exec`. Without
# scripts/, tsx exits "file not found" — and because update.sh treats that step as a warning
# rather than a failure (correctly: one bad tenant must not roll back everyone's upgrade), the
# breakage was invisible. Every non-default org silently stayed on its old schema, which is the
# exact drift the additive-only migration policy cannot excuse.
# The second is the P3009 recovery path (see the migration Job in the Helm chart and update.sh):
# a stranded `_prisma_migrations` row is the one failure mode `migrate deploy` cannot clear by
# retrying, and the doctor is what clears it. Neither is reachable if the file isn't in the image.
COPY --from=build --chown=app:app /app/apps/api/scripts apps/api/scripts
COPY --from=build --chown=app:app /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=app:app /app/packages/shared/package.json packages/shared/package.json
COPY --chown=app:app package.json ./
COPY --chown=app:app apps/api/package.json apps/api/package.json
RUN mkdir -p /app/uploads/avatars && chown -R app:app /app/uploads
USER app
EXPOSE 4000
CMD ["node", "apps/api/dist/src/server.js"]
