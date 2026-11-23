$ErrorActionPreference = "Stop"

$ServiceRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent (Split-Path -Parent $ServiceRoot)
$PythonExe = Join-Path $ServiceRoot ".venv\Scripts\python.exe"
$SpecFile = Join-Path $PSScriptRoot "dubcera_voices.spec"
$WorkDir = Join-Path $ServiceRoot "build\pyinstaller"
$DistDir = Join-Path $ServiceRoot "dist"
$ReleaseDir = Join-Path $RepoRoot "release\DubCera-Voices-Windows"
$ExtensionId = "agjbmkobficdohbngajcmfhggabapncl"

if (-not (Test-Path $PythonExe)) {
    throw "Python venv not found at $PythonExe"
}

Write-Host "[1/3] Building DubCeraVoices.exe with PyInstaller..." -ForegroundColor Cyan
& $PythonExe -m PyInstaller --noconfirm --clean --workpath $WorkDir --distpath $DistDir $SpecFile
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed with exit code $LASTEXITCODE"
}

Write-Host "[2/3] Assembling portable release folder at $ReleaseDir..." -ForegroundColor Cyan
if (Test-Path $ReleaseDir) {
    Remove-Item -Recurse -Force $ReleaseDir
}
New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $DistDir "DubCeraVoices\*") $ReleaseDir

@"
@echo off
cd /d "%~dp0"
echo ==========================================================
echo   Cai dat lien ket tu dong cho DubCera Extension
echo   - Extension se TU BAT DubCeraVoices khi xem video
echo   - Tu dong TAT hoan toan (0 MB RAM) sau 3 phut khong dung
echo ==========================================================
"DubCeraVoices.exe" --register-native-host --extension-id $ExtensionId
echo.
echo Hoan tat! Tu gio ban KHONG can bat thu cong nua.
pause
"@ | Set-Content -Encoding ASCII (Join-Path $ReleaseDir "Install-DubCera-Voices.bat")

@"
@echo off
cd /d "%~dp0"
"DubCeraVoices.exe" --unregister-native-host
"DubCeraVoices.exe" --uninstall-startup
echo.
echo Da go lien ket tu dong cua DubCeraVoices.
pause
"@ | Set-Content -Encoding ASCII (Join-Path $ReleaseDir "Uninstall-DubCera-Voices.bat")

@"
@echo off
cd /d "%~dp0"
start "" /B "DubCeraVoices.exe" --background --idle-shutdown 180
echo DubCera Voices Server da khoi chay ngam (tu tat sau 3 phut ranh).
timeout /t 2 >nul
"@ | Set-Content -Encoding ASCII (Join-Path $ReleaseDir "Start-Silent.bat")

@"
DubCera Voices (Portable Windows Build - Tu bat / Tu tat)
=========================================================
Khong can cai Python, khong can tai source code.

1. Cai dat 1 lan duy nhat (khuyen dung):
   Nhay dup "Install-DubCera-Voices.bat".
   -> Dang ky Native Messaging cho ca Chrome va Edge.
   -> Khi mo video va chon giong VieNeu, Extension TU DONG bat DubCeraVoices.exe.
   -> Khi ngung xem 3 phut, DubCeraVoices.exe TU DONG tat han (0 MB RAM).

2. Go bo lien ket tu dong:
   Nhay dup "Uninstall-DubCera-Voices.bat".

3. Chay thu cong (neu muon xem log truc tiep):
   Nhay dup "DubCeraVoices.exe".

Thu muc cache & log: %LOCALAPPDATA%\DubCera
"@ | Set-Content -Encoding UTF8 (Join-Path $ReleaseDir "HUONG-DAN.txt")

Write-Host "[3/3] Done! Portable package ready at: $ReleaseDir" -ForegroundColor Green
