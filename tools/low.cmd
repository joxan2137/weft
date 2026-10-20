@echo off
rem Runs a command at idle CPU priority; child processes inherit it.
rem usage: tools\low.cmd <command> [args...]
start "" /low /b /wait %*
exit /b %errorlevel%
