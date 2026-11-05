@echo off
chcp 65001 >nul
title Stargazer
cd /d "%~dp0"
echo.
echo   Starting local server, please wait...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
echo.
echo   Server stopped.
pause
