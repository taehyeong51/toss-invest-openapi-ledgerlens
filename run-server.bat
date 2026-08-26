@echo off
setlocal

title LedgerLens Development Server
cd /d "%~dp0"

if not exist "node_modules\.bin\vinext.cmd" (
    echo Dependencies are missing. Installing them...
    call npm install
    if errorlevel 1 (
        echo.
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
)

echo Starting LedgerLens at http://localhost:3000
call npm run dev

echo.
echo The server has stopped.
pause
