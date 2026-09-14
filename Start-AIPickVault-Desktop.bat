@echo off
cd /d "C:\Users\bamte\OneDrive\Desktop\AIPickVault-Desktop"
title AIPickVault Desktop
echo Starting AIPickVault Desktop...
echo Keep this window open while the app runs.
npm start
if errorlevel 1 pause
