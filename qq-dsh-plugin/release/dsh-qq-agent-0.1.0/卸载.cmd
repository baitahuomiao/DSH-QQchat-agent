@echo off
rem ============================================================
rem  dsh-qq-agent uninstaller
rem
rem  NOTE: keep this file pure ASCII. cmd.exe parses batch files in
rem  the OEM codepage; non-ASCII text here breaks parsing. All
rem  Chinese messages live in tools\install.mjs instead.
rem ============================================================
chcp 65001 >nul
setlocal

echo.
echo   ============================================
echo    dsh-qq-agent uninstaller
echo   ============================================
echo.

set "NODE_EXE="

for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"

if not defined NODE_EXE (
  for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if exist "%%D\dependencies\node\bin\node.exe" set "NODE_EXE=%%D\dependencies\node\bin\node.exe"
  )
)

if not defined NODE_EXE (
  echo   [xx] node.exe not found.
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0tools\install.mjs" --uninstall %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo   ============================================
  echo    Removed. Restart DeepSeek Harness to apply.
  echo   ============================================
) else (
  echo   ============================================
  echo    Uninstall failed ^(exit code %RC%^).
  echo   ============================================
)

echo.
pause
endlocal
exit /b %RC%
