@echo off
rem Starts the Linaw demo (app window + demo backend) in its own console.
rem Close this window to stop everything.
title Linaw demo
cd /d "%~dp0"
if not exist node_modules call pnpm install
call pnpm dev:demo
