FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install --include=dev --no-audit --no-fund

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
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
# The control-plane Prisma client is plain generated JS (not compiled by tsc), so it isn't
# under apps/api/dist on its own — copy it to the exact path config/control-prisma.js's
# compiled relative import (`../generated/control-client/index.js`) expects to find it at.
COPY --from=build /app/apps/api/src/generated apps/api/dist/src/generated
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY package.json ./
COPY apps/api/package.json apps/api/package.json
EXPOSE 4000
CMD ["node", "apps/api/dist/src/server.js"]
