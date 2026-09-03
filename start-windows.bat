@echo off
setlocal
cd /d "%~dp0"
title Knowledge Workbench

echo ==================================================
echo   Knowledge Workbench - unified knowledge base
echo ==================================================
echo.

set KB_HOST=127.0.0.1
if "%KB_PORT%"=="" set KB_PORT=8787
if "%KB_DATA_DIR%"=="" set KB_DATA_DIR=%~dp0data

where python >nul 2>nul
if errorlevel 1 goto USE_NODE

echo [1/2] Starting Python server on port %KB_PORT% ...
echo       Web UI  : http://127.0.0.1:%KB_PORT%
echo       Data dir: %KB_DATA_DIR%
echo       Press Ctrl+C to stop.
echo.
start "" /B cmd /c "timeout /t 3 >nul & start "" http://127.0.0.1:%KB_PORT%"
python server_py\main.py serve
goto END

:USE_NODE
where node >nul 2>nul
if errorlevel 1 goto NO_RUNTIME
echo [!] python not found, falling back to Node runtime ...
echo [1/2] Starting Node server on port %KB_PORT% ...
start "" /B cmd /c "timeout /t 3 >nul & start "" http://127.0.0.1:%KB_PORT%"
node server\src\index.js
goto END

:NO_RUNTIME
echo [X] Neither python nor node was found in PATH.
echo     Please install Python 3.9+ (recommended) or Node.js 18+.
pause

:END
endlocal
