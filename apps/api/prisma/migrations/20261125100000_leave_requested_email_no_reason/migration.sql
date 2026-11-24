-- V17 privacy fix: the leave.requested email no longer carries the requester's free-text reason.
-- An email outlives the decision and is copied to the super-admin BCC; the approver reads the reason
-- (and any document) in the app instead.
--
-- ONLY the untouched default is replaced: the row is updated when its body still hashes to the body
-- 20261124100000_leave_management inserted (== prisma/email-templates-seed.ts at that commit). A
-- template an admin has edited is left exactly as it is. The variables list follows the body.
UPDATE `EmailTemplate`
SET
  `bodyHtml` = '<!doctype html>
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
                    <td style="padding:6px 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Days</td>
                    <td style="padding:6px 0 10px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{days}}</td>
                  </tr>
                  </table>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;color:#0F172A;">Open TimeSphere to review the request and any reason or document attached to it.</p>
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
  `variables` = JSON_ARRAY('approverName', 'employeeName', 'leaveType', 'dates', 'days', 'appUrl'),
  `updatedAt` = NOW(3)
WHERE `key` = 'leave.requested'
  AND SHA2(`bodyHtml`, 256) = '6d02e6e9e4da7e43a540d28a8f3be26be80e671fbce1d3b10280ff192d27ff10';
