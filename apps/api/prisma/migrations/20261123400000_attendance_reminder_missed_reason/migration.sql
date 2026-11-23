-- V17 A4: the punch-in reminder's email category and template.
--
-- The category toggle ships ON: the reminder only ever fires when an admin has switched attendance
-- on AND its own punchInReminderEnabled, so this column alone sends nothing.
ALTER TABLE `GlobalNotificationSettings`
  ADD COLUMN `emailPunchInReminder` BOOLEAN NOT NULL DEFAULT true;

-- WHY THE TEMPLATE IS INSERTED HERE AS WELL AS IN prisma/seed.ts: the seed is a one-time bootstrap
-- that never runs on upgrade (see 20260819220000_change_email_templates). The markup is generated
-- verbatim from prisma/email-templates-seed.ts so fresh and upgraded installs send the same design.
-- INSERT IGNORE: an existing row (a fresh install that already seeded it) is left alone.
INSERT IGNORE INTO `EmailTemplate` (`id`, `key`, `subject`, `bodyHtml`, `description`, `variables`, `enabled`, `updatedAt`)
VALUES (
  UUID(), 'reminder.punch_in',
  'You haven''t punched in yet ({{date}})',
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
<div style="display:none;font-size:1px;color:#F7F9FB;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Log in and punch in so today''s attendance is recorded.</div>
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
            <h1 class="ts-h1" style="margin:0 0 14px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:24px;line-height:32px;letter-spacing:-0.2px;font-weight:800;color:#0F172A;">Hi {{name}}, you haven''t punched in yet</h1>
            <p style="margin:0 0 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;color:#0F172A;">We haven''t recorded a punch-in for you on <strong>{{date}}</strong>.</p>
            <p style="margin:0 0 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#0F172A;">Log in to TimeSphere and punch in so your attendance for today is recorded. It takes a few seconds.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E2E8F0;border-left:4px solid #F59E0B;border-radius:8px;margin:16px 0;background-color:#FAFBFC;">
              <tr>
                <td style="padding:6px 16px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:10px 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Date</td>
                    <td style="padding:10px 0 10px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#F59E0B;">{{date}}</td>
                  </tr>
                  </table>
                </td>
              </tr>
            </table>
            <table role="presentation" class="ts-btn" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 8px;">
              <tr>
                <td align="center">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{appUrl}}/app" style="height:46px;v-text-anchor:middle;width:240px;" arcsize="14%" strokecolor="#F59E0B" fillcolor="#F59E0B">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;">Open TimeSphere and punch in</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <a href="{{appUrl}}/app" target="_blank" style="display:inline-block;background-color:#F59E0B;color:#ffffff;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;line-height:1;text-decoration:none;padding:14px 28px;border-radius:8px;border:1px solid #F59E0B;">Open TimeSphere and punch in</a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>
            <p style="margin:0 0 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#64748B;">Already punched in through a badge reader or another system? It can take a few minutes to arrive - you can ignore this.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid #E2E8F0;">
              <tr>
                <td style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#64748B;">
                  Sent at the punch-in reminder hour set in Workspace Settings - Attendance & Leave, on your working days only.
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
  'Punch-in reminder at the Attendance & Leave reminder hour, on working days with no punch from any source.',
  JSON_ARRAY('name','date','appUrl'),
  true, NOW(3)
);
