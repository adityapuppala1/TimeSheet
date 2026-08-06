@echo off
rem One-click installer launcher for Windows.
rem
rem WHY THIS FILE EXISTS: PowerShell's execution policy (Restricted by default on Windows
rem clients) blocks .\install.ps1 with "running scripts is disabled on this system" BEFORE any
rem line of it runs - so no script can fix its own launch. Batch files are not subject to that
rem policy, and -ExecutionPolicy Bypass below is PROCESS-scoped: nothing about the machine's
rem policy is changed, no admin rights are needed, and the bypass ends when the script does.
rem
rem Usage:  .\install.cmd   (all arguments pass through to install.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
