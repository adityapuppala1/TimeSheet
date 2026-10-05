# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
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

# Production dependencies of the API alone — no web packages (mermaid, three, lucide…), no test runners
# or compilers. The runtime used to copy the build stage's full monorepo install: 1.46 GB, most of it
# for the browser bundle or for tooling. prisma and tsx are runtime dependencies of THIS image (boot
# runs `prisma migrate deploy`; the documented seeds and `doctor` run through tsx), so they live in
# apps/api's "dependencies", not devDependencies. Every workspace's package.json is copied because
# `npm ci` validates the whole lockfile even when installing one workspace.
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace apps/api --workspace packages/shared --no-audit --no-fund  && mkdir -p apps/api/node_modules packages/shared/node_modules

FROM node:24-alpine
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
COPY --from=prod-deps --chown=app:app /app/node_modules node_modules
# The tenant Prisma client is generated INTO node_modules/.prisma by the build stage's `prisma
# generate`; the production install above never ran generate, so it has none of its own.
COPY --from=build --chown=app:app /app/node_modules/.prisma node_modules/.prisma
# Workspace-local installs too: npm nests a package under the workspace when its version differs from
# the hoisted one (dotenv, and ldapts until 2026-10-05). Shipping only the root node_modules made the
# API crash at boot with ERR_MODULE_NOT_FOUND — invisible to every test run from a full checkout.
COPY --from=prod-deps --chown=app:app /app/apps/api/node_modules apps/api/node_modules
COPY --from=prod-deps --chown=app:app /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=build --chown=app:app /app/apps/api/dist apps/api/dist
COPY --from=build --chown=app:app /app/apps/api/prisma apps/api/prisma
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
# The generated Prisma clients are plain JS that tsc does not compile into dist/, but
# config/control-prisma.js's compiled relative import expects them at dist/src/generated. A symlink
# to the copy src/ already carries, instead of a second COPY of the same tree (and its engine).
RUN ln -s ../../src/generated apps/api/dist/src/generated && chown -h app:app apps/api/dist/src/generated  && mkdir -p /app/uploads/avatars && chown -R app:app /app/uploads
USER app
EXPOSE 4000
CMD ["node", "apps/api/dist/src/server.js"]
