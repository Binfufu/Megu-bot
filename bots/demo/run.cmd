@echo off
setlocal
pushd "%~dp0..\.." || exit /b 1
set "QQBOT_ENV_FILE=%~dp0.env"
node "%CD%\scripts\launch.js"
set "QQBOT_EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %QQBOT_EXIT_CODE%
