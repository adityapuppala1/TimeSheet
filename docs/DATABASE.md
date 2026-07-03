# Database Design

The Prisma schema in `apps/api/prisma/schema.prisma` defines the MySQL model.

Core tables:

- `users`, `roles`, `permissions`, `role_permissions`
- `sessions`, `password_reset_tokens`, `email_verification_tokens`
- `projects`, `modules`, `submodules`, `user_project_assignments`
- `activity_types`, `timesheets`, `attachments`
- `notifications`, `audit_logs`, `form_configurations`

Design notes:

- UUID primary keys for distributed safety.
- Soft delete fields via `deletedAt`.
- Audit fields via `createdAt` and `updatedAt`.
- Indexed foreign keys and common report filters.
- Role and permission mapping supports dynamic RBAC.

