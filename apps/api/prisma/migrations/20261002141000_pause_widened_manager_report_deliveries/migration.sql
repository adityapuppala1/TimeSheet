-- Scheduled dashboard reports owned by a manager or team lead that reach an outside address are
-- paused until their owner has looked at the recipients.
--
-- WHY: a scheduled report used to be built from the owner's OWN project assignments. It now covers
-- exactly what the owner's live dashboard shows (services/dashboard-scope.service.ts), which for a
-- MANAGER or TEAM_LEAD includes the projects of their direct reports. Widgets with no project pinned
-- — project mix, upcoming milestones, counts — therefore start listing those projects' names and
-- milestones. A team lead's weekly report to one client could begin describing another client's
-- project, and nobody re-confirmed who the report goes to.
--
-- WHAT IT CHANGES: ACTIVE subscriptions whose owner's primary role is MANAGER or TEAM_LEAD and that
-- list at least one recipient address matching no account in this workspace. They are set inactive
-- with a plain explanation in `lastSendError`, which the Scheduled delivery tab shows beside the
-- Paused badge; the owner resumes from there (PATCH /api/dashboards/subscriptions/:id). Deliveries
-- that reach only colleagues keep running — those people can open the same dashboard already.
-- Data only — no table, column or index changes.
--
-- PORTABLE ON PURPOSE:
--   * The recipient list is a JSON array, walked by index (0-99; a delivery holds at most 50)
--     rather than with JSON_TABLE, which MariaDB only gained in 10.6.
--   * Each extracted address is converted to utf8mb4 and compared under `User`.`email`'s own
--     collation (utf8mb4_unicode_ci, declared by the migration that created the table), so the
--     match is case-insensitive like the worker's and cannot meet MySQL error 1267.
--   * Single-table UPDATE; its subqueries read `User`, `Role` and literal derived tables, never
--     `ReportSubscription`, so MySQL error 1093 cannot arise.
--
-- IDEMPOTENT: it touches only rows that are still active, and leaves them inactive.
UPDATE `ReportSubscription` AS `rs`
SET `rs`.`isActive` = FALSE,
    `rs`.`lastSendError` = 'Paused after an update: scheduled reports now cover the same projects as your live dashboard, including your team''s. Check the recipients, then resume.'
WHERE `rs`.`isActive` = TRUE
  AND `rs`.`createdById` IN (
    SELECT `owner`.`id`
    FROM `User` AS `owner`
    INNER JOIN `Role` AS `role` ON `role`.`id` = `owner`.`roleId`
    WHERE `role`.`name` IN ('MANAGER', 'TEAM_LEAD')
  )
  AND EXISTS (
    SELECT 1
    FROM (SELECT 0 AS `d` UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
          UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS `ones`,
         (SELECT 0 AS `d` UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
          UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS `tens`
    WHERE `tens`.`d` * 10 + `ones`.`d` < JSON_LENGTH(`rs`.`recipients`)
      AND NOT EXISTS (
        SELECT 1
        FROM `User` AS `u`
        WHERE `u`.`email` = CONVERT(
          JSON_UNQUOTE(JSON_EXTRACT(`rs`.`recipients`, CONCAT('$[', `tens`.`d` * 10 + `ones`.`d`, ']'))) USING utf8mb4
        ) COLLATE utf8mb4_unicode_ci
      )
  );
