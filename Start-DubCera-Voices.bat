@echo off
chcp 65001 >nul
title DubCera Local Multi-Voice Server (Auto-Idle RAM Release)
echo ==========================================================
echo   DubCera Local TTS Server (127.0.0.1:8765)
echo   - Tu dong nap giong Nam/Nu khi xem video
echo   - Tu dong giai phong RAM ve ~50MB sau 60s nghi / DC-TAT
echo ==========================================================
cd /d "%~dp0services\tts-local"
".venv\Scripts\python.exe" -m dubcera_tts
pause
