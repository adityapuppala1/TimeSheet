-- 7.0.0: the seeded digest.weekly body never carried {{tablesHtml}}, so a tenant on the default
-- template got the summary but not the counted last-week / month-to-date / year-to-date tables the
-- worker renders. This adds the placeholder after {{expectedHoursHtml}}.
--
-- ONLY the untouched default is replaced: the row is updated when its body still hashes to the body
-- migration 20261125400000 wrote. A template an admin has edited is left exactly as it is (they can
-- add {{tablesHtml}} in the editor).
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
<div style="display:none;font-size:1px;color:#F7F9FB;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">An AI-authored recap of your ticket and timesheet activity.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F7F9FB" style="background-color:#F7F9FB;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" class="ts-container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:12px;border:1px solid #E2E8F0;overflow:hidden;">
        <tr>
          <td bgcolor="#3B82F6" style="padding:20px 28px;background-color:#3B82F6;">
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
            <h1 class="ts-h1" style="margin:0 0 14px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:24px;line-height:32px;letter-spacing:-0.2px;font-weight:800;color:#0F172A;">Hi {{name}}, here''s your week</h1>
            <p style="margin:0 0 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;color:#0F172A;">{{summary}}</p>
{{expectedHoursHtml}}
{{tablesHtml}}
            <table role="presentation" class="ts-btn" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 8px;">
              <tr>
                <td align="center">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{appUrl}}/app" style="height:46px;v-text-anchor:middle;width:240px;" arcsize="14%" strokecolor="#3B82F6" fillcolor="#3B82F6">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;">Open your dashboard</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <a href="{{appUrl}}/app" target="_blank" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;line-height:1;text-decoration:none;padding:14px 28px;border-radius:8px;border:1px solid #3B82F6;">Open your dashboard</a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>
            <p style="margin:0 0 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#64748B;">This recap is AI-generated from your ticket and timesheet activity — turn it off anytime in your notification preferences.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid #E2E8F0;">
              <tr>
                <td style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#64748B;">
                  You''re receiving this because of activity on your TimeSphere workspace. Manage notification preferences inside the app.
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
  `updatedAt` = NOW(3)
WHERE `key` = 'digest.weekly'
  AND SHA2(`bodyHtml`, 256) = '6d9c9a031cc37d427e01be9f6cbf1dc5ea9d57804f41898577b17adf394df98a';
