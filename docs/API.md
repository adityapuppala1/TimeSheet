# API Documentation

Base URL: `/api`

## Auth

- `POST /auth/login` `{ email, password, rememberMe }`
- `POST /auth/refresh` `{ refreshToken }`
- `POST /auth/logout`
- `POST /auth/forgot-password` `{ email }`
- `POST /auth/reset-password` `{ token, password }`
- `POST /auth/change-password` `{ currentPassword, nextPassword }`
- `GET /auth/me`

## Users

- `GET /users?search=&role=&status=&page=1`
- `POST /users`
- `PATCH /users/:id`
- `DELETE /users/:id`
- `POST /users/:id/reset-password`

## Projects

- `GET /projects`
- `POST /projects`
- `PATCH /projects/:id`
- `POST /projects/:id/modules`
- `POST /modules/:id/submodules`

## Timesheets

- `GET /timesheets?from=&to=&userId=&projectId=&status=`
- `POST /timesheets/draft`
- `POST /timesheets/submit`
- `PATCH /timesheets/:id/approve`
- `PATCH /timesheets/:id/reject`

## Reports

- `GET /reports/employee-summary`
- `GET /reports/admin-summary`
- `GET /reports/export.xlsx`
- `GET /reports/export.pdf`

