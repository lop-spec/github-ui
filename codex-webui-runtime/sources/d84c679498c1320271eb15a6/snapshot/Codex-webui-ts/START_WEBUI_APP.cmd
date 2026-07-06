@echo off
setlocal
cd /d "%~dp0"
node scripts\webui-app.mjs --launch %*
