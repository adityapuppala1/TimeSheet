-- 7.0.0: a kiosk QR nonce is single use across everyone, not once per person, so a code that is
-- photographed and forwarded cannot punch a second person in. Rows live minutes (they are pruned on
-- write), so collapsing any per-person duplicates of one nonce to a single row loses nothing.
DELETE n1 FROM `AttendanceKioskNonce` n1
  JOIN `AttendanceKioskNonce` n2 ON n1.`kioskId` = n2.`kioskId` AND n1.`nonce` = n2.`nonce` AND n1.`id` > n2.`id`;

CREATE UNIQUE INDEX `AttendanceKioskNonce_kioskId_nonce_key` ON `AttendanceKioskNonce`(`kioskId`, `nonce`);

DROP INDEX `AttendanceKioskNonce_userId_kioskId_nonce_key` ON `AttendanceKioskNonce`;
