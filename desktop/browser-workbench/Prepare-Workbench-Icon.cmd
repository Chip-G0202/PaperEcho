@echo off
pwsh.exe -NoLogo -NoProfile -File "%~dp0Prepare-Workbench-Icon.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)
