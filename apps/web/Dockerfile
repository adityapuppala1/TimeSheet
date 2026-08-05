FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install --include=dev --no-audit --no-fund
# vite.config.ts bakes the repo-root VERSION into the bundle (__APP_VERSION__); without this
# COPY a Docker build would fall back to "0.0.0-dev" and the update-refresh prompt would never
# fire for anyone served from this image.
COPY VERSION ./
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w packages/shared && npm run build -w apps/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
