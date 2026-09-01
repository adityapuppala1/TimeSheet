-- Unreleased: a local llama.cpp server becomes a provider kind, and any provider can declare what
-- it is able to serve.
--
-- WHY THIS EXISTS. This product's provider list has always described WHO answers a call and never
-- WHAT that answerer is capable of, because until now every row was a hosted API with a context
-- window and an output ceiling far beyond anything the app asks for. A model running on the
-- operator's own hardware breaks that assumption in the least forgiving way: it is the right
-- choice for the dozens of small decision-shaped calls this app makes constantly (triage a ticket,
-- judge a duplicate, pick an assignee) and the wrong choice for the four generators that ask for
-- thousands of output tokens in one go. With nothing in the schema able to say so, "make the local
-- model primary" would mean every one of those heavy calls spends the full 90-second
-- MODEL_CALL_TIMEOUT_MS discovering it — per call, before the cloud provider behind it gets a
-- turn. `maxOutputTokens` and `contextWindow` are how a row says "do not ask me that", and
-- ai.service.ts#getEnabledProviderConfigsForTask skips it BEFORE opening a socket rather than
-- after failing one.
--
-- LLAMA_CPP IS APPENDED, NOT INSERTED beside OPENAI_COMPATIBLE where a reader would file it — the
-- two speak the same wire protocol and belong together in a taxonomy. MySQL stores an ENUM as the
-- ORDINAL of its member: appending rewrites only the table definition (the column still fits in one
-- byte, so it is an in-place alter), while inserting into the middle rewrites every existing row's
-- stored ordinal, silently turning every `OPENAI_COMPATIBLE` row into whatever now occupies slot 2.
-- The list is a storage layout, not a taxonomy. Same argument
-- `20260831150000_quality_gate_and_code_quality_findings` makes for QUALITY and LINT, and
-- `packages/shared/src/index.ts` repeats it beside `aiProviders` so nobody has to find this file to
-- learn it.
--
-- BOTH TABLES CARRYING `AIProvider` ARE RESTATED. `GlobalAISettings.provider` is the deprecated
-- BYOK singleton — unread by any dispatch code since V9 — and it would be tempting to leave it
-- alone. It must not be: Prisma compares the LIVE database against the whole schema, so a column
-- whose enum definition lags behind the model would show up as drift on every subsequent
-- `migrate dev`, and the next person to run one would be offered a migration they did not write.
--
-- WHAT EXISTING ROWS DO:
--   * Every existing `AIProviderConfig` and `GlobalAISettings` row keeps its provider, its ordinal
--     and its meaning. Widening an enum by appending changes no row: ANTHROPIC stays 1,
--     OPENAI_COMPATIBLE stays 2, and LLAMA_CPP takes 3. No row is converted to the new kind and
--     none could be — a native row points at a runtime that this release does not yet start.
--   * `maxOutputTokens` and `contextWindow` are NULL for every existing row, and NULL is the
--     CORRECT value rather than a gap to be backfilled. NULL means "has declared no limit", which
--     is exactly true: nobody has been asked yet, and there is nothing to infer it from — a model
--     name is not a capacity, and guessing one would start silently skipping providers that work.
--     The demand filter treats NULL as "try it", so routing behaviour after this migration is
--     identical to routing behaviour before it, for every workspace, until an admin fills a number
--     in. That is what makes this upgrade a no-op.
--   * No row is created, deleted, re-prioritised or disabled, and no circuit-breaker counter moves.
--     This migration widens two column definitions and adds two nullable columns.
--
-- THERE IS NO BACKFILL IN THIS FILE, on purpose (see above), and the DDL is guarded anyway. The two
-- enum restatements need no guard because repeating them is a no-op — restating a column definition
-- that already matches changes nothing — while the ADD COLUMN uses the information_schema + PREPARE
-- guard, so a re-run after a partial failure is a no-op rather than a duplicate-column error.
-- `20260817100000_session_device_identity` is the incident that made that the house rule. Both new
-- columns are added by ONE statement guarded on ONE of them: they arrive together, so if
-- `maxOutputTokens` is present `contextWindow` is too. The file deliberately does NOT carry the
-- auto-heal marker (the one scripts/lib/migration-recovery.ts looks for in a SQL comment, spelled
-- out in docs/DATABASE.md and NOT repeated here, because writing it down at all is what sets it).
-- That marker authorises `npm run setup` to clear a failed record and re-apply UNATTENDED against
-- real data, which is a promise worth making only for the migration that needs auto-healing, not
-- for every safe one.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
-- The third provider kind, on the table that actually dispatches. A full restatement of the column
-- is how MySQL adds an enum member; there is no additive form. Repeating this statement is
-- harmless, which is why it needs no guard.
ALTER TABLE `AIProviderConfig` MODIFY `provider` ENUM('ANTHROPIC', 'OPENAI_COMPATIBLE', 'LLAMA_CPP') NOT NULL DEFAULT 'ANTHROPIC';

-- AlterTable
-- The deprecated singleton, restated for the same enum — see the header on why the unread column
-- still has to move.
ALTER TABLE `GlobalAISettings` MODIFY `provider` ENUM('ANTHROPIC', 'OPENAI_COMPATIBLE', 'LLAMA_CPP') NOT NULL DEFAULT 'ANTHROPIC';

-- AlterTable
-- Declared capacity. Both NULLABLE with no default, so every existing row acquires them holding the
-- answer that changes nothing: "no declared limit".
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `AIProviderConfig` ADD COLUMN `maxOutputTokens` INTEGER NULL, ADD COLUMN `contextWindow` INTEGER NULL',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'AIProviderConfig'
    AND `COLUMN_NAME` = 'maxOutputTokens'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;
