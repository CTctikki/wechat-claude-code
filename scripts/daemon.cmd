@echo off
setlocal enabledelayedexpansion

:: wechat-claude-code Windows daemon manager
:: Usage: daemon.cmd [start|stop|status|logs]

set "DATA_DIR=%USERPROFILE%\.wechat-claude-code"
set "PID_FILE=%DATA_DIR%\daemon.pid"
set "LOG_DIR=%DATA_DIR%\logs"
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."

if "%1"=="" goto usage
if "%1"=="start" goto start
if "%1"=="stop" goto stop
if "%1"=="status" goto status
if "%1"=="logs" goto logs
goto usage

:: -------------------------------------------------------
:start
:: -------------------------------------------------------
if exist "%PID_FILE%" (
    set /p OLD_PID=<"%PID_FILE%"
    tasklist /FI "PID eq !OLD_PID!" 2>nul | find "!OLD_PID!" >nul
    if !errorlevel! equ 0 (
        echo Already running (PID !OLD_PID!^)
        exit /b 1
    ) else (
        echo Stale PID file found, removing...
        del "%PID_FILE%" 2>nul
    )
)

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Get current date/time for log file name
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set "DT=%%I"
set "LOG_FILE=%LOG_DIR%\daemon-%DT:~0,8%.log"

echo Starting wechat-claude-code daemon...

:: Start in background using wmic process create
:: We use "start /B" with output redirected to log
start "wcc-daemon" /B /MIN cmd /c "cd /d "%PROJECT_DIR%" && node dist/main.js start >> "%LOG_FILE%" 2>&1 & echo %errorlevel%"

:: Give it a moment to start
timeout /t 2 /nobreak >nul

:: Find the node process we just started
for /f "tokens=2" %%P in ('wmic process where "commandline like '%%wechat-claude-code%%main.js%%' and name='node.exe'" get processid 2^>nul ^| findstr /r "[0-9]"') do set "NEW_PID=%%P"

if not defined NEW_PID (
    :: Fallback: try to find node process
    for /f "tokens=2" %%P in ('tasklist /FI "IMAGENAME eq node.exe" /FO LIST 2^>nul ^| findstr /i "PID"') do set "NEW_PID=%%P"
)

if defined NEW_PID (
    echo !NEW_PID!>"%PID_FILE%"
    echo Started (PID !NEW_PID!^)
    echo Log: %LOG_FILE%
) else (
    echo Started (PID unknown - check logs^)
    echo Log: %LOG_FILE%
)
goto end

:: -------------------------------------------------------
:stop
:: -------------------------------------------------------
if not exist "%PID_FILE%" (
    echo Not running (no PID file^)
    exit /b 1
)

set /p PID=<"%PID_FILE%"
tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
if %errorlevel% neq 0 (
    echo Not running (stale PID %PID%^)
    del "%PID_FILE%" 2>nul
    exit /b 1
)

echo Stopping daemon (PID %PID%^)...
taskkill /PID %PID% /F >nul 2>&1
del "%PID_FILE%" 2>nul
echo Stopped.
goto end

:: -------------------------------------------------------
:status
:: -------------------------------------------------------
if not exist "%PID_FILE%" (
    echo Status: not running
    exit /b 1
)

set /p PID=<"%PID_FILE%"
tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
if %errorlevel% equ 0 (
    echo Status: running (PID %PID%^)
) else (
    echo Status: not running (stale PID %PID%^)
    del "%PID_FILE%" 2>nul
)
goto end

:: -------------------------------------------------------
:logs
:: -------------------------------------------------------
if not exist "%LOG_DIR%" (
    echo No logs directory found.
    exit /b 1
)

:: Find the most recent log file
set "LATEST_LOG="
for /f "delims=" %%F in ('dir /b /o-d "%LOG_DIR%\daemon-*.log" 2^>nul') do (
    if not defined LATEST_LOG set "LATEST_LOG=%LOG_DIR%\%%F"
)

if not defined LATEST_LOG (
    echo No log files found.
    exit /b 1
)

echo Showing: %LATEST_LOG%
echo (Press Ctrl+C to stop^)
echo ----------------------------------------

:: Show last 50 lines, then tail
powershell -Command "Get-Content '%LATEST_LOG%' -Tail 50 -Wait"
goto end

:: -------------------------------------------------------
:usage
:: -------------------------------------------------------
echo Usage: %~nx0 {start^|stop^|status^|logs}
echo.
echo Commands:
echo   start   Start the daemon in background
echo   stop    Stop the running daemon
echo   status  Check if daemon is running
echo   logs    Show and follow daemon logs

:end
endlocal
