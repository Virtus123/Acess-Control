@echo off
REM ===========================================================
REM  MAM Push Service — start local (Windows)
REM ===========================================================
REM  Subir em modo desenvolvimento, aceitando equipamento na LAN.
REM  Dashboard: http://localhost:3001/admin/ui/
REM
REM  Para produção, use o PM2 em vez deste script.
REM ===========================================================

cd /d "%~dp0\.."

set PUSH_HOST=0.0.0.0
set PUSH_PORT=3001
set NODE_ENV=development
set LOG_LEVEL=info
set PUSH_TRUST_LAN=1
set PUSH_DEBUG_INGRESS=1

echo.
echo ===========================================================
echo  MAM Push Service
echo  Porta:    %PUSH_PORT%
echo  Host:     %PUSH_HOST%  (aceita LAN)
echo  Trust LAN: %PUSH_TRUST_LAN%
echo  Dashboard: http://localhost:%PUSH_PORT%/admin/ui/
echo ===========================================================
echo.

node push-service\server.js
