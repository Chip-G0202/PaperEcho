@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if not "%~2"=="" goto usage
if "%~1"=="--stop" goto stop
if not "%~1"=="" goto usage
where node.exe >nul 2>nul
if errorlevel 1 goto missing
node.exe "%~dp0workflow\tools\web\launcher.mjs"
goto result
:stop
where node.exe >nul 2>nul
if errorlevel 1 goto missing
node.exe "%~dp0workflow\tools\web\launcher.mjs" --stop
:result
set "launchExit=%errorlevel%"
if not "%launchExit%"=="0" pause
exit /b %launchExit%
:missing
echo PaperEcho requires Node.js 18 or later. Install/configure Node.js and try again.
pause
exit /b 2
:usage
echo Usage: PaperEcho.cmd [--stop]
exit /b 1
