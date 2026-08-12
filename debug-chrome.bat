@echo off
setlocal
title Chrome for DevCDP

set "PORT=9222"
rem The same directory the server computes for this port, so the companion extension —
rem which has to be installed by hand, because branded Chrome refuses --load-extension —
rem is present however Chrome was started, and survives because this is not a temp dir.
set "PROFILE=%LOCALAPPDATA%\DevCDP\chrome-profiles\port-%PORT%"
set "EXT=C:\Users\dd\Project\DevCDP\extension"

echo.
echo   DevCDP debug browser
echo   -------------------------------------------------
echo   Port    : %PORT%
echo   Profile : %PROFILE%   (separate from your normal Chrome)
echo.

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not defined CHROME (
  echo   [ERROR] Chrome was not found in the usual locations.
  echo           Set DEVCDP_CHROME_PATH, or edit this file.
  echo.
  pause
  exit /b 1
)

if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1

start "" "%CHROME%" ^
  --remote-debugging-port=%PORT% ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-backgrounding-occluded-windows ^
  --disable-features=CalculateNativeWinOcclusion ^
  --no-restore-session-state ^
  --hide-crash-restore-bubble ^
  --disable-extensions-except="%EXT%" ^
  --load-extension="%EXT%"

echo   Chrome launched. Open your app, then describe the bug to your assistant.
echo.
echo   Optional, one time: to get coloured tab groups per session, open
echo     chrome://extensions  ^>  enable Developer mode  ^>  Load unpacked
echo     and select:  %EXT%
echo   Recent Chrome builds ignore --load-extension, so this step may be needed.
echo   Everything else works without it.
echo.
timeout /t 4 /nobreak >nul
