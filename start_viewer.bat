@echo off
REM Start the AI office viewer (Windows). On macOS / Linux use start_viewer.sh.
REM
REM Comments here are deliberately ASCII: cmd.exe reads .bat files using the
REM system ANSI codepage (CP932 on Japanese Windows), so UTF-8 Japanese in this
REM file would be garbled and can break command parsing.
REM
REM chcp 65001 + -X utf8 keeps the console and Python on the same encoding so
REM the Japanese output from server.py renders correctly.
chcp 65001 >nul
cd /d "%~dp0"
python -X utf8 -u server.py
