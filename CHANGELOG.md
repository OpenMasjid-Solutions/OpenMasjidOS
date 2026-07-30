<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# What's new in OpenMasjidOS

Newest first. The dashboard reads this file (Settings → Advanced → **What's new**),
so keep the wording plain and friendly — a masjid volunteer is the reader, not a
sysadmin. One `## <version>` heading per release, then short bullets.

## 0.47.0

- Emails from OpenMasjidOS look properly designed now, and no longer arrive with your logo as a file attached to them.
- Alert emails say what happened in one clear line, show the details at a glance, and give you a button that opens the right page — instead of asking you to hunt through menus.
- Subject lines are plain English. They no longer start with "[OpenMasjidOS]", and the same words are no longer repeated three times in one email.
- Your masjid's logo appears in emails when remote access is set up. Without it, your masjid's name appears instead — email programs can only load pictures from the internet, not from your own network.

## 0.46.0

- Apps now find the dashboard again after you move the box to a different network. Before this, an app kept trying the old address forever and quietly stopped talking to OpenMasjidOS.
- Third-party apps are no longer shared over the internet unless you ask. Community and Docker Compose apps now have the same "share this online" question that App Store apps have, and it starts switched off.
- Apps can no longer reach into another app's private network. This joins the existing protection that stops them reaching another app's data.
- Fixed a case where a backup could report success even though part of it failed to save — for example when the disk filled up.
- Closed a gap where a specially written web address could reach parts of OpenMasjidOS that are meant to stay on your network only.
- Added this "What's new" page.

## 0.45.0

- Apps that need a public web address now ask you during install instead of silently going without one, and the "Shared online" switch is easier to find — it's on the app's own page and always visible in Settings.
- Backups are now honest: if any part of a backup can't be saved, the whole backup fails instead of quietly leaving something out. Older backups are no longer deleted after a failed run.
- Restoring a backup now pauses your apps first, so their data can't be damaged while it's being put back, and tells you if any app's data couldn't be restored.
- Apps can no longer be installed, updated, or restored if they try to open another app's data.
- App updates are now safety-checked the same way installs are.

## 0.44.0

- You now get an alert when a new version of OpenMasjidOS or one of your apps is available.

## 0.43.0

- You can upload your masjid's logo in Settings → Customize. It appears on emails OpenMasjidOS sends and on your notification messages.

## 0.42.0

- Alerts can now be sent to email, to your webhook, or both — choose per alert in Settings → Alerts.

## 0.41.0

- OpenMasjidOS can send email. Set up SMTP or Resend in Settings → Email, send yourself a test, and apps can send mail through it without ever handling your password.
- Alerts let you know when something needs attention, such as an app going offline.

## 0.40.0

- Apps can now securely ask each other for information, and you choose which apps are shared over the internet.
