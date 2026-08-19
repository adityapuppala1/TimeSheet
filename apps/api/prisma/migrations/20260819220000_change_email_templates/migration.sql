-- Registers the two change-management email templates.
--
-- WHY A MIGRATION AND NOT JUST THE SEED: prisma/seed.ts is a ONE-TIME bootstrap that never runs on
-- upgrade, so a template added there alone reaches fresh installs and no others - the same rule the
-- permission backfills follow. Without this, an existing workspace would send change mail that never
-- appears on the Email templates page, and therefore never appears in its delivery analytics.
--
-- WHY THE HTML IS THE FULL DESIGN AND NOT A PLACEHOLDER: this row is what an admin opens, edits and
-- previews, and it is what actually sends. Seeding a bare `<p>` here would have given upgraded
-- workspaces a plainer email than fresh ones - the same template key rendering two different
-- designs depending on when you installed. The markup below is generated verbatim from
-- `prisma/email-templates-seed.ts`, so both paths deliver the identical, table-based,
-- Outlook-safe layout every other template in this app uses.
INSERT IGNORE INTO `EmailTemplate` (`id`, `key`, `subject`, `bodyHtml`, `description`, `variables`, `enabled`, `updatedAt`)
VALUES (
  UUID(), 'change.submitted',
  'Approval needed: {{changeKey}} - {{title}}',
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
<div style="display:none;font-size:1px;color:#F7F9FB;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">{{requestedBy}} submitted a change that needs your approval.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F7F9FB" style="background-color:#F7F9FB;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" class="ts-container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:12px;border:1px solid #E2E8F0;overflow:hidden;">
        <tr>
          <td bgcolor="#0F9AA8" style="padding:20px 28px;background-color:#0F9AA8;">
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
            <h1 class="ts-h1" style="margin:0 0 14px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:24px;line-height:32px;letter-spacing:-0.2px;font-weight:800;color:#0F172A;">A change needs your approval</h1>
            <p style="margin:0 0 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;color:#0F172A;"><strong>{{requestedBy}}</strong> submitted a change on <strong>{{projectName}}</strong> and it is waiting on you.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E2E8F0;border-left:4px solid #0F9AA8;border-radius:8px;margin:16px 0;background-color:#FAFBFC;">
              <tr>
                <td style="padding:6px 16px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:10px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Change</td>
                    <td style="padding:10px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#0F9AA8;">{{changeKey}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Project</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{projectName}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Title</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{title}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Type</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{changeType}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Risk</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{riskLevel}} ({{riskScore}})</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Activity window</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{activityWindow}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Requested by</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{requestedBy}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Received by</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{receivedBy}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">People involved</td>
                    <td style="padding:6px 0 10px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{peopleInvolved}}</td>
                  </tr>
                  </table>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;color:#0F172A;">{{description}}</p>
            <table role="presentation" class="ts-btn" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 8px;">
              <tr>
                <td align="center">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{appUrl}}" style="height:46px;v-text-anchor:middle;width:240px;" arcsize="14%" strokecolor="#0F9AA8" fillcolor="#0F9AA8">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;">Review and decide</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <a href="{{appUrl}}" target="_blank" style="display:inline-block;background-color:#0F9AA8;color:#ffffff;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;line-height:1;text-decoration:none;padding:14px 28px;border-radius:8px;border:1px solid #0F9AA8;">Review and decide</a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>
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
  'Sent the moment a change is submitted - to its approver, the requester, and everyone tagged on it.',
  JSON_ARRAY('changeKey','projectName','title','changeType','riskLevel','riskScore','activityWindow','description','requestedBy','receivedBy','peopleInvolved','appUrl'),
  true, NOW(3)
);

INSERT IGNORE INTO `EmailTemplate` (`id`, `key`, `subject`, `bodyHtml`, `description`, `variables`, `enabled`, `updatedAt`)
VALUES (
  UUID(), 'change.decided',
  'Change {{decision}}: {{changeKey}} - {{title}}',
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
<div style="display:none;font-size:1px;color:#F7F9FB;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">{{decidedBy}} {{decision}} this change.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F7F9FB" style="background-color:#F7F9FB;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" class="ts-container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:12px;border:1px solid #E2E8F0;overflow:hidden;">
        <tr>
          <td bgcolor="#0F9AA8" style="padding:20px 28px;background-color:#0F9AA8;">
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
            <h1 class="ts-h1" style="margin:0 0 14px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:24px;line-height:32px;letter-spacing:-0.2px;font-weight:800;color:#0F172A;">{{changeKey}} was {{decision}}</h1>
            <p style="margin:0 0 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;color:#0F172A;"><strong>{{decidedBy}}</strong> reviewed "<strong>{{title}}</strong>" on {{projectName}}.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E2E8F0;border-left:4px solid #0F9AA8;border-radius:8px;margin:16px 0;background-color:#FAFBFC;">
              <tr>
                <td style="padding:6px 16px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:10px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Change</td>
                    <td style="padding:10px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#0F9AA8;">{{changeKey}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Project</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{projectName}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Title</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{title}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Type</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{changeType}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Risk</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{riskLevel}} ({{riskScore}})</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Activity window</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{activityWindow}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Requested by</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{requestedBy}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Decision by</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{decidedBy}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">Comments</td>
                    <td style="padding:6px 0 6px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{comments}}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">People involved</td>
                    <td style="padding:6px 0 10px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#0F172A;">{{peopleInvolved}}</td>
                  </tr>
                  </table>
                </td>
              </tr>
            </table>
            <table role="presentation" class="ts-btn" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 8px;">
              <tr>
                <td align="center">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{appUrl}}" style="height:46px;v-text-anchor:middle;width:240px;" arcsize="14%" strokecolor="#0F9AA8" fillcolor="#0F9AA8">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;">Open the change</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <a href="{{appUrl}}" target="_blank" style="display:inline-block;background-color:#0F9AA8;color:#ffffff;font-family:''Segoe UI'',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;line-height:1;text-decoration:none;padding:14px 28px;border-radius:8px;border:1px solid #0F9AA8;">Open the change</a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>
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
  'Sent when a change is approved or rejected, carrying who decided and their comments.',
  JSON_ARRAY('changeKey','projectName','title','changeType','riskLevel','riskScore','activityWindow','description','requestedBy','receivedBy','peopleInvolved','appUrl','decision','decidedBy','comments'),
  true, NOW(3)
);
