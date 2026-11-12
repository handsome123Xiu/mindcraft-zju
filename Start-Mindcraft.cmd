@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0..\runtime\node-v22.23.4-win-x64\node.exe" set "PATH=%~dp0..\runtime\node-v22.23.4-win-x64;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto missing
node -e "process.exit(process.versions.node.split('.')[0] === '22' ? 0 : 1)"
if errorlevel 1 goto missing
if not exist andy.json node scripts/setup-local.mjs
set "MINECRAFT_PORT="
set /p "MINECRAFT_PORT=Enter the current Minecraft Open-to-LAN port: "
if not defined MINECRAFT_PORT (
    echo Open your world to LAN and enter the port shown in Minecraft chat.
    goto done
)
node scripts/check-setup.mjs
if errorlevel 1 goto done
node main.js
goto done
:missing
echo Install Node.js 22 LTS and reopen this terminal.
:done
pause
endlocal
