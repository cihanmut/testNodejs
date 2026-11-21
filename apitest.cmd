@echo off
rem Windows launcher (cmd or PowerShell):  apitest.cmd <command> ...
rem Needs only Node.js 18 or newer. No npm install, no admin rights.
setlocal
pushd "%~dp0"
node "%~dp0src\cli.js" %*
set "APITEST_RC=%ERRORLEVEL%"
popd
exit /b %APITEST_RC%
