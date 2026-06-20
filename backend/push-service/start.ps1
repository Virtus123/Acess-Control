# MAM Push Service — start local (PowerShell)
# Dashboard: http://localhost:3001/admin/ui/

Set-Location (Join-Path $PSScriptRoot '..')

$env:PUSH_HOST = '0.0.0.0'
$env:PUSH_PORT = '3001'
$env:NODE_ENV = 'development'
$env:LOG_LEVEL = 'info'
$env:PUSH_TRUST_LAN = '1'
$env:PUSH_DEBUG_INGRESS = '1'

Write-Host ''
Write-Host '===========================================================' -ForegroundColor Cyan
Write-Host '  MAM Push Service' -ForegroundColor Cyan
Write-Host "  Porta:     $env:PUSH_PORT"
Write-Host "  Host:      $env:PUSH_HOST  (aceita LAN)"
Write-Host "  TrustLAN:  $env:PUSH_TRUST_LAN"
Write-Host "  Dashboard: http://localhost:$env:PUSH_PORT/admin/ui/" -ForegroundColor Yellow
Write-Host '===========================================================' -ForegroundColor Cyan
Write-Host ''

node push-service\server.js
