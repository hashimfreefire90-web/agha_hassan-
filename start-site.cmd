@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run the website.
  echo Install Node.js, then double-click this file again.
  pause
  exit /b 1
)
set "PORT="
for /f %%P in ('powershell -NoProfile -Command "$p=3000; while($true){try{$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$p);$l.Start();$l.Stop();break}catch{$p++}}; $p"') do set "PORT=%%P"
if not defined PORT (
  echo Could not find a free local website port.
  pause
  exit /b 1
)
echo Starting Agha Hassan Motor Club at http://127.0.0.1:%PORT%/
start "Agha Hassan Motor Club Server" cmd /k "set PORT=%PORT% && node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/"
endlocal