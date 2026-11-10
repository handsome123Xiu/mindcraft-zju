@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing
if not exist andy.json node scripts/setup-local.mjs
set "MINECRAFT_PORT=25565"
set /p "MINECRAFT_PORT=Minecraft LAN port [25565]: "
node scripts/check-setup.mjs
if errorlevel 1 goto done
node main.js
goto done
:missing
echo Install Node.js 22 LTS and reopen this terminal.
:done
pause
endlocal
