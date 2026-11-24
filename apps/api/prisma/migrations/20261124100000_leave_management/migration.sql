-- V17 Phase B: leave types, the balance ledger, leave requests, leave settings and the two leave
-- email categories. See schema.prisma (LEAVE) for why the balance is a ledger and never a column.

-- AlterTable
ALTER TABLE `GlobalAttendanceSettings` ADD COLUMN `leaveApprovalFallback` ENUM('ADMINS', 'SUPER_ADMINS') NOT NULL DEFAULT 'ADMINS',
    ADD COLUMN `leaveEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `leaveYearStartMonth` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `trustExternalApprovals` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `emailLeaveDecided` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailLeaveRequested` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `LeaveType` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `colour` VARCHAR(32) NOT NULL DEFAULT 'primary',
    `annualQuota` DECIMAL(6, 2) NOT NULL DEFAULT 0,
    `accrual` ENUM('YEARLY_UPFRONT', 'MONTHLY_PRORATA') NOT NULL DEFAULT 'YEARLY_UPFRONT',
    `carryForwardMax` DECIMAL(6, 2) NOT NULL DEFAULT 0,
    `allowHalfDay` BOOLEAN NOT NULL DEFAULT true,
    `isPaid` BOOLEAN NOT NULL DEFAULT true,
    `requiresApproval` BOOLEAN NOT NULL DEFAULT true,
    `requiresDocumentAfterDays` INTEGER NULL,
    `allowNegative` BOOLEAN NOT NULL DEFAULT false,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `LeaveType_code_key`(`code`),
    INDEX `LeaveType_enabled_sortOrder_idx`(`enabled`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeaveBalanceLedger` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `leaveTypeId` VARCHAR(191) NOT NULL,
    `leaveYear` INTEGER NOT NULL,
    `delta` DECIMAL(6, 2) NOT NULL,
    `kind` ENUM('ACCRUAL', 'CARRY_FORWARD', 'DEBIT', 'CREDIT_REVERSAL', 'ADJUSTMENT', 'EXPIRY') NOT NULL,
    `reason` VARCHAR(255) NULL,
    `refRequestId` VARCHAR(64) NULL,
    `actorId` VARCHAR(64) NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LeaveBalanceLedger_idempotencyKey_key`(`idempotencyKey`),
    INDEX `LeaveBalanceLedger_userId_leaveTypeId_leaveYear_idx`(`userId`, `leaveTypeId`, `leaveYear`),
    INDEX `LeaveBalanceLedger_refRequestId_idx`(`refRequestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeaveRequest` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `leaveTypeId` VARCHAR(191) NOT NULL,
    `startDate` DATE NOT NULL,
    `endDate` DATE NOT NULL,
    `startHalf` ENUM('FULL', 'FIRST_HALF', 'SECOND_HALF') NOT NULL DEFAULT 'FULL',
    `endHalf` ENUM('FULL', 'FIRST_HALF', 'SECOND_HALF') NOT NULL DEFAULT 'FULL',
    `days` DECIMAL(6, 2) NOT NULL,
    `leaveYear` INTEGER NOT NULL,
    `reason` TEXT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `attachmentUrl` VARCHAR(512) NULL,
    `attachmentName` VARCHAR(255) NULL,
    `attachmentMimeType` VARCHAR(120) NULL,
    `attachmentSize` INTEGER NULL,
    `approverId` VARCHAR(64) NULL,
    `decidedById` VARCHAR(64) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` TEXT NULL,
    `overriddenBySuperAdmin` BOOLEAN NOT NULL DEFAULT false,
    `cancelledAt` DATETIME(3) NULL,
    `source` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV') NOT NULL DEFAULT 'WEB',
    `externalRef` VARCHAR(191) NULL,
    `dedupeKey` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `LeaveRequest_dedupeKey_key`(`dedupeKey`),
    INDEX `LeaveRequest_userId_status_startDate_idx`(`userId`, `status`, `startDate`),
    INDEX `LeaveRequest_status_startDate_endDate_idx`(`status`, `startDate`, `endDate`),
    INDEX `LeaveRequest_approverId_status_idx`(`approverId`, `status`),
    INDEX `LeaveRequest_leaveTypeId_idx`(`leaveTypeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LeaveBalanceLedger` ADD CONSTRAINT `LeaveBalanceLedger_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeaveBalanceLedger` ADD CONSTRAINT `LeaveBalanceLedger_leaveTypeId_fkey` FOREIGN KEY (`leaveTypeId`) REFERENCES `LeaveType`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeaveRequest` ADD CONSTRAINT `LeaveRequest_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeaveRequest` ADD CONSTRAINT `LeaveRequest_leaveTypeId_fkey` FOREIGN KEY (`leaveTypeId`) REFERENCES `LeaveType`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- WHY THE PRESETS ARE INSERTED HERE (not only in prisma/seed.ts): the seed never runs on upgrade, and
-- fresh and upgraded installs must offer the same starting point. All three ship DISABLED: nothing is
-- offered to anyone until an admin reviews the quotas and switches a type on. INSERT IGNORE on the
-- unique `code`: re-running, or an admin who already created a "PL", leaves the existing row alone.
INSERT IGNORE INTO `LeaveType` (`id`, `code`, `name`, `colour`, `annualQuota`, `accrual`, `carryForwardMax`, `allowHalfDay`, `isPaid`, `requiresApproval`, `requiresDocumentAfterDays`, `allowNegative`, `enabled`, `sortOrder`, `updatedAt`)
VALUES
  (UUID(), 'PL', 'Privilege leave', 'primary', 18.00, 'MONTHLY_PRORATA', 15.00, true, true, true, NULL, false, false, 10, NOW(3)),
  (UUID(), 'CL', 'Casual leave', 'info', 8.00, 'YEARLY_UPFRONT', 0.00, true, true, true, NULL, false, false, 20, NOW(3)),
  (UUID(), 'SL', 'Sick leave', 'warning', 8.00, 'YEARLY_UPFRONT', 0.00, true, true, true, 2, false, false, 30, NOW(3));

-- The two leave email templates. Same reasoning as 20261123400000_attendance_reminder_missed_reason:
-- the seed never runs on upgrade, so the markup (generated verbatim from prisma/email-templates-seed.ts)
-- is inserted here too. INSERT IGNORE leaves an existing (fresh-install or admin-edited) row alone.
INSERT IGNORE INTO `EmailTemplate` (`id`, `key`, `subject`, `bodyHtml`, `description`, `variables`, `enabled`, `updatedAt`)
VALUES (
  UUID(), 'leave.requested',
  '{{employeeName}} requested {{days}} day(s) of {{leaveType}}',
  '<!doctype html>
<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TimeSphere</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  @media only screen and (max-width:620px) {
    .ts-container { width:100% !important; max-width:100% !important; }
    .ts-px { padding-left:20px !important; padding-right:20px !important; }
    .ts-stack { display:block !important; width:100% !important; }
    .ts-h1 { font-size:22px !important; line-height:30px !important; }
    .ts-btn a { padding:14px 22px !important; font-size:14px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#F7F9FB;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;color:#0F172A;">
<div style="display:none;font-size:1px;color:#F7F9FB;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">A leave request is waiting for your decision.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F7F9FB" style="background-color:#F7F9FB;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" class="ts-container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:12px;border:1px solid #E2E8F0;overflow:hidden;">
        <tr>
          <td bgcolor="#F59E0B" style="padding:20px 28px;background-color:#F59E0B;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:18px;font-weight:800;color:#FFFFFF;letter-spacing:0.4px;">
                  TimeSphere
                </td>
                <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:1px;font-weight:600;">
                  Enterprise Time Tracking
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="ts-px" style="padding:28px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;color:#0F172A;font-size:14px;line-height:22px;">
            <h1 class="ts-h1" style="margin:0 0 14px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:24px;line-height:32px;letter-spacing:-0.2px;font-weight:800;color:#0F172A;">Hi {{approverName}}, a leave request needs your decision</h1>
            <p style="margin:0 0 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;color:#0F172A;"><strong>{{employeeName}}</strong> has asked for {{leaveType}}.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E2E8F0;border-left:4px solid #F59E0B;border-radius:8px;margin:16px 0;background-color:#FAFBFC;">
              <tr>
                <td style="padding:6px 16px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:10px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Dates</td>
                    <td style="padding:10px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#F59E0B;">{{dates}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Days</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{days}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Reason</td>
                    <td style="padding:6px 0 10px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{reason}}</td>
                  </tr>
                  </table>
                </td>
              </tr>
            </table>
            <table role="presentation" class="ts-btn" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 8px;">
              <tr>
                <td align="center">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{appUrl}}/app/attendance" style="height:46px;v-text-anchor:middle;width:240px;" arcsize="14%" strokecolor="#F59E0B" fillcolor="#F59E0B">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;">Review the request</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <a href="{{appUrl}}/app/attendance" target="_blank" style="display:inline-block;background-color:#F59E0B;color:#ffffff;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;line-height:1;text-decoration:none;padding:14px 28px;border-radius:8px;border:1px solid #F59E0B;">Review the request</a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid #E2E8F0;">
              <tr>
                <td style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#64748B;">
                  You are receiving this because you approve leave for this person in TimeSphere.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
      <table role="presentation" class="ts-container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        <tr>
          <td align="center" style="padding:14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#94A3B8;">
            © TimeSphere &middot; This is an automated message
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>',
  'Sent to the approver (the person''s manager, or the admin pool when they have none) when a leave request needs a decision.',
  JSON_ARRAY('approverName','employeeName','leaveType','dates','days','reason','appUrl'),
  true, NOW(3)
);
INSERT IGNORE INTO `EmailTemplate` (`id`, `key`, `subject`, `bodyHtml`, `description`, `variables`, `enabled`, `updatedAt`)
VALUES (
  UUID(), 'leave.decided',
  'Your {{leaveType}} request was {{decision}}',
  '<!doctype html>
<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TimeSphere</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  @media only screen and (max-width:620px) {
    .ts-container { width:100% !important; max-width:100% !important; }
    .ts-px { padding-left:20px !important; padding-right:20px !important; }
    .ts-stack { display:block !important; width:100% !important; }
    .ts-h1 { font-size:22px !important; line-height:30px !important; }
    .ts-btn a { padding:14px 22px !important; font-size:14px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#F7F9FB;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;color:#0F172A;">
<div style="display:none;font-size:1px;color:#F7F9FB;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Your leave request has been decided.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F7F9FB" style="background-color:#F7F9FB;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" class="ts-container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:12px;border:1px solid #E2E8F0;overflow:hidden;">
        <tr>
          <td bgcolor="#F59E0B" style="padding:20px 28px;background-color:#F59E0B;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:18px;font-weight:800;color:#FFFFFF;letter-spacing:0.4px;">
                  TimeSphere
                </td>
                <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:1px;font-weight:600;">
                  Enterprise Time Tracking
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="ts-px" style="padding:28px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;color:#0F172A;font-size:14px;line-height:22px;">
            <h1 class="ts-h1" style="margin:0 0 14px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:24px;line-height:32px;letter-spacing:-0.2px;font-weight:800;color:#0F172A;">Hi {{name}}, your leave request was {{decision}}</h1>
            <p style="margin:0 0 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;color:#0F172A;">Your request for {{leaveType}} has been <strong>{{decision}}</strong> by {{decidedBy}}.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E2E8F0;border-left:4px solid #F59E0B;border-radius:8px;margin:16px 0;background-color:#FAFBFC;">
              <tr>
                <td style="padding:6px 16px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:10px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Dates</td>
                    <td style="padding:10px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#F59E0B;">{{dates}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Days</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{days}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Note</td>
                    <td style="padding:6px 0 10px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{note}}</td>
                  </tr>
                  </table>
                </td>
              </tr>
            </table>
            <table role="presentation" class="ts-btn" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 8px;">
              <tr>
                <td align="center">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{appUrl}}/app/attendance" style="height:46px;v-text-anchor:middle;width:240px;" arcsize="14%" strokecolor="#F59E0B" fillcolor="#F59E0B">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;">Open TimeSphere</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <a href="{{appUrl}}/app/attendance" target="_blank" style="display:inline-block;background-color:#F59E0B;color:#ffffff;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;line-height:1;text-decoration:none;padding:14px 28px;border-radius:8px;border:1px solid #F59E0B;">Open TimeSphere</a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid #E2E8F0;">
              <tr>
                <td style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#64748B;">
                  Sent when a leave request you made is approved or rejected.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
      <table role="presentation" class="ts-container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        <tr>
          <td align="center" style="padding:14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#94A3B8;">
            © TimeSphere &middot; This is an automated message
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>',
  'Sent to the person who asked for leave when their request is approved or rejected.',
  JSON_ARRAY('name','leaveType','decision','decidedBy','dates','days','note','appUrl'),
  true, NOW(3)
);
