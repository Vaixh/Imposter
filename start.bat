@echo off
chcp 65001 >nul
title Imposter-Server
cd /d "%~dp0"

rem Startet den Imposter-Server. Fenster offen lassen, solange ihr spielt.
node server.js

echo.
echo Der Server wurde beendet.
pause