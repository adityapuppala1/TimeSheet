// Prisma 7 looks for its config in the directory a command runs from. Docker Compose, Helm and the
// installers run `prisma migrate deploy --schema=apps/api/prisma/...` from the REPO ROOT, so the API's
// config is re-exported here. It resolves its own paths, and picks the database from --schema.
export { default } from "./apps/api/prisma.config.ts";
