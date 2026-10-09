@echo off
rem Double-click this file to open a terminal that asks for a short link and shows where it goes.
title Universal URL Resolver
cd /d "%~dp0"
node apps\cli\src\main.ts -i
echo.
pause
