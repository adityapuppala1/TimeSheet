@echo off
rem One-click updater launcher for Windows.
rem
rem WHY THIS FILE EXISTS: PowerShell's execution policy (Restricted by default on Windows
rem clients) blocks .\update.ps1 with "running scripts is disabled on this system" BEFORE any
rem line of it runs - so no script can fix its own launch. Batch files are not subject to that
rem policy, and -ExecutionPolicy Bypass below is PROCESS-scoped: nothing about the machine's
rem policy is changed, no admin rights are needed, and the bypass ends when the script does.
rem
rem Usage:  .\update.cmd                (update to the newest release tag)
rem         .\update.cmd --to v1.1.0    (pin or roll back to a specific release)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
exit /b %ERRORLEVEL%
