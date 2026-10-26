@echo off
rem Inicia el servidor d'horaris i obre l'aplicació al navegador.
cd /d "%~dp0"
start "" http://localhost:8000
python server.py
