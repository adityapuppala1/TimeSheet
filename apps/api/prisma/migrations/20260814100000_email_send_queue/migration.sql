-- Turns EmailLog from an audit trail into the outbound send QUEUE.
--
-- EmailLog has always had a QUEUED status and nothing ever re-drove a row out of it: sendMail
-- wrote QUEUED, hit the SMTP server in the same breath, and wrote SENT or FAILED. So a provider
-- answering "451 too many messages, slow down" lost that email permanently — and a burst (a bulk
-- approval, the daily reminder sweep) opened one connection per message simultaneously, which is
-- what earns the 451 to begin with.
--
-- `payload` holds the rendered message ONLY while the row is still deliverable; the worker clears
-- it on SENT or on giving up, so this stays an audit log rather than becoming a copy of every
-- email the workspace has ever sent.
--
-- Table and column names are in the canonical casing on purpose. 2.3.0's migrations shipped 37
-- names generated in the case-insensitive Windows dialect and died mid-migration on case-sensitive
-- Linux MySQL; see the CHANGELOG's upgrade note.
ALTER TABLE `EmailLog`
  ADD COLUMN `attempts`      INT         NOT NULL DEFAULT 0,
  ADD COLUMN `nextAttemptAt` DATETIME(3) NULL,
  ADD COLUMN `lastAttemptAt` DATETIME(3) NULL,
  ADD COLUMN `payload`       JSON        NULL;

-- The drain query: due-and-queued, oldest first.
CREATE INDEX `EmailLog_status_nextAttemptAt_idx` ON `EmailLog` (`status`, `nextAttemptAt`);

-- Per-workspace SMTP throttle. Defaults are the conservative intersection of what the common
-- providers allow (Office 365: 30 messages/minute and 3 concurrent connections; Gmail SMTP: ~20
-- concurrent; SES: a per-account send rate), leaving headroom for the audit BCC.
ALTER TABLE `GlobalMailSettings`
  ADD COLUMN `maxConnections`       INT NOT NULL DEFAULT 3,
  ADD COLUMN `maxMessagesPerWindow` INT NOT NULL DEFAULT 25,
  ADD COLUMN `rateWindowMs`         INT NOT NULL DEFAULT 60000;
