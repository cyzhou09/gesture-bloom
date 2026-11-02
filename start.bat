@echo off
setlocal EnableExtensions
title Finger Bloom - Local Server
cd /d "%~dp0"
set "PORT=%~1"
if not defined PORT set "PORT=4173"

echo.
echo   +----------------------------------------------+
echo   ^|  Finger Bloom - bloom at your fingertips     ^|
echo   +----------------------------------------------+
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node

for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
if defined NODE_VERSION (
  echo   Node.js %NODE_VERSION% found.
) else (
  echo   Node.js found.
)
echo.
echo   Starting local server and opening your browser...
echo   URL: http://localhost:%PORT%
echo.
echo   Keep this window open while using the flower.
echo   Press Ctrl+C to stop the server.
echo.

node serve.mjs --open --port %PORT%
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" (
  echo   [ERROR] Server exited with code %EXIT_CODE%.
  echo   Port %PORT% may already be in use. Close the other server and try again.
  echo   Or choose another port: start.bat 8080
) else (
  echo   Server stopped.
)
echo.
pause
exit /b %EXIT_CODE%

:no_node
echo   [ERROR] Node.js was not found on this computer.
echo.
echo   Install Node.js 22 or newer, then run this file again:
echo   https://nodejs.org/
echo.
pause
exit /b 1
