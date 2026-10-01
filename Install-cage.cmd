@echo off
rem Double-click to install cage on Windows 11. It runs cage's installer (install.ps1 from the latest
rem release) in PowerShell; Windows may ask for permission along the way.
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/z-brenner/cage/releases/latest/download/install.ps1 | iex"
pause
