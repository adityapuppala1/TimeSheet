-- Enforce: at most ONE open incident per service.
--
-- WHY: opening an incident was a check-then-act — read the open incidents, create one if this
-- service has none. Two health runs overlapping (the five-minute worker and a manual "check now"
-- are enough) both read "none open" and both inserted, so one outage produced two incidents a
-- millisecond apart and the status page reported the same failure twice.
--
-- MySQL has no partial unique index, so open-ness lives in a column the constraint can see:
-- `openKey` holds the service name while the incident is open and NULL once it closes. NULLs do
-- not collide in a MySQL unique index, which gives exactly the rule wanted — any number of closed
-- incidents per service, never two open ones.

-- 1. The column, nullable, so this is additive and safe on a populated table.
ALTER TABLE `ServiceIncident` ADD COLUMN `openKey` VARCHAR(60) NULL;

-- 2. Merge duplicates BEFORE the constraint exists, or this migration fails on any install the
--    bug already affected.
--
--    "Merge" rather than "delete the newer one": the duplicates are one event recorded twice, not
--    two events. The earliest start is when the outage actually began, so that row is kept and the
--    others' sample counts are folded into it — otherwise the surviving incident under-reports how
--    many failing probes it spanned, and that count is what distinguishes a real outage from one
--    unlucky sample.
CREATE TEMPORARY TABLE `_incident_keepers` AS
SELECT `service`, MIN(`startedAt`) AS `firstStart`
FROM `ServiceIncident`
WHERE `endedAt` IS NULL
GROUP BY `service`
HAVING COUNT(*) > 1;

CREATE TEMPORARY TABLE `_incident_merge` AS
SELECT
  (SELECT i2.`id`
     FROM `ServiceIncident` i2
    WHERE i2.`service` = k.`service` AND i2.`endedAt` IS NULL AND i2.`startedAt` = k.`firstStart`
    LIMIT 1) AS `keepId`,
  k.`service` AS `service`,
  (SELECT SUM(i3.`sampleCount`)
     FROM `ServiceIncident` i3
    WHERE i3.`service` = k.`service` AND i3.`endedAt` IS NULL) AS `totalSamples`
FROM `_incident_keepers` k;

UPDATE `ServiceIncident` i
  JOIN `_incident_merge` m ON m.`keepId` = i.`id`
   SET i.`sampleCount` = m.`totalSamples`;

DELETE i FROM `ServiceIncident` i
  JOIN `_incident_merge` m ON m.`service` = i.`service`
 WHERE i.`endedAt` IS NULL AND i.`id` <> m.`keepId`;

DROP TEMPORARY TABLE `_incident_merge`;
DROP TEMPORARY TABLE `_incident_keepers`;

-- 3. Backfill the remaining open incidents so the constraint describes reality.
UPDATE `ServiceIncident` SET `openKey` = `service` WHERE `endedAt` IS NULL AND `openKey` IS NULL;

-- 4. The constraint itself.
CREATE UNIQUE INDEX `ServiceIncident_openKey_key` ON `ServiceIncident`(`openKey`);
