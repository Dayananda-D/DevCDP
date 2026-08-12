@echo off
setlocal enabledelayedexpansion
title Browser Debugger MCP Setup

echo.
echo  =============================================
echo   Browser Debugger MCP ^| Interactive Setup
echo  =============================================
echo.

:: ── Step 1: Detect this folder ───────────────────────────────────────────────
set "DEBUGG_DIR=%~dp0"
if "%DEBUGG_DIR:~-1%"=="\" set "DEBUGG_DIR=%DEBUGG_DIR:~0,-1%"
set "SERVER_PATH=%DEBUGG_DIR%\server.js"

if not exist "%SERVER_PATH%" (
    echo  [ERROR] server.js not found in this folder.
    echo          Make sure initialize_MCP.bat is inside the project folder.
    echo.
    pause
    exit /b 1
)

:: ── Step 2: Check Node.js ─────────────────────────────────────────────────────
echo  Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js is not installed.
    echo          Download it from: https://nodejs.org
    echo          Install it, then run this script again.
    echo.
    pause
    exit /b 1
)

:: ── Step 3: Install dependencies ──────────────────────────────────────────────
echo  Installing dependencies...
cd /d "%DEBUGG_DIR%"
call npm install --loglevel=error
if errorlevel 1 (
    echo.
    echo  [ERROR] npm install failed. Check your internet connection.
    echo.
    pause
    exit /b 1
)
echo.

:: ── Step 4: Run Node.js Setup Wizard ──────────────────────────────────────────
node initialize_MCP.js
if errorlevel 1 (
    echo.
    echo  [ERROR] Setup wizard failed.
    echo.
    pause
    exit /b 1
)

echo.
pause
