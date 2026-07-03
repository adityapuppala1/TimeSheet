# Deployment Guide

1. Provision MySQL 8.
2. Set environment variables from `.env.example`.
3. Run `npm ci`.
4. Run `npm run db:generate && npm run db:migrate`.
5. Build with `npm run build`.
6. Deploy `apps/api/dist` behind HTTPS with `WEB_ORIGIN` configured.
7. Deploy `apps/web/dist` behind a static host or Nginx.
8. Configure SMTP and background queue provider for production email delivery.
9. Enable database backups, access logs, and centralized metrics.

