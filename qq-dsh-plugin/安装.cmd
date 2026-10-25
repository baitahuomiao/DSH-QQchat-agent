@echo off
rem ============================================================
rem  dsh-qq-agent installer
rem  Installs the plugin into the local DeepSeek Harness (DSH).
rem
rem  NOTE: keep this file pure ASCII. cmd.exe parses batch files
rem  in the OEM codepage; non-ASCII text here breaks parsing and
rem  produces bizarre "not recognized as a command" errors.
rem  All Chinese messages live in tools\install.mjs instead.
rem ============================================================
chcp 65001 >nul
setlocal

echo.
echo   ============================================
echo    dsh-qq-agent installer
echo   ============================================
echo.

set "NODE_EXE="

rem --- prefer node from PATH ---
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"

rem --- otherwise use the runtime bundled with DSH ---
if not defined NODE_EXE (
  for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if exist "%%D\dependencies\node\bin\node.exe" set "NODE_EXE=%%D\dependencies\node\bin\node.exe"
  )
)

if not defined NODE_EXE (
  echo   [xx] node.exe not found.
  echo.
  echo        Install Node.js, or start DeepSeek Harness once so it
  echo        downloads its own runtime, then run this script again.
  echo.
  pause
  exit /b 1
)

echo   node: %NODE_EXE%
echo.

"%NODE_EXE%" "%~dp0tools\install.mjs" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo   ============================================
  echo    Done. Now close DeepSeek Harness and open it again.
  echo   ============================================
) else (
  echo   ============================================
  echo    Install failed ^(exit code %RC%^).
  echo    Send the output above back to the author.
  echo   ============================================
)

echo.
pause
endlocal
exit /b %RC%
