# Envia Client ID + cert/key para Supabase Secrets (PEM em Base64).
# Uso (na pasta RifaPIX):
#   .\scripts\set-sicoob-secrets.ps1

param(
  [string]$ClientId = '79dda30f-d70f-4ff7-bd74-79509ea137d2',
  [string]$PixKey = '93136803191'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$cert = Join-Path $root 'sicoob-cert.pem'
$key = Join-Path $root 'sicoob-key.pem'
if (-not (Test-Path $cert)) { throw "Falta $cert - rode .\scripts\export-sicoob-pem.ps1" }
if (-not (Test-Path $key)) { throw "Falta $key - rode .\scripts\export-sicoob-pem.ps1" }

function To-B64File([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  return [Convert]::ToBase64String($bytes)
}

$certB64 = To-B64File $cert
$keyB64 = To-B64File $key

Write-Host "Cert PEM: $((Get-Item $cert).Length) bytes -> Base64 $($certB64.Length) chars"
Write-Host "Key PEM : $((Get-Item $key).Length) bytes -> Base64 $($keyB64.Length) chars"
Write-Host "ClientId: $ClientId"
Write-Host "PixKey  : $PixKey"
Write-Host ''

npx supabase secrets set `
  "SICOOB_CLIENT_ID=$ClientId" `
  "SICOOB_PIX_KEY=$PixKey" `
  "PIX_PROVIDER=sicoob" `
  "SICOOB_ENV=prod" `
  "SICOOB_CERT_PEM=$certB64" `
  "SICOOB_KEY_PEM=$keyB64"

Write-Host ''
Write-Host 'OK. Agora rode o redeploy:'
Write-Host '  npx supabase functions deploy create-pix-charge-workspace --no-verify-jwt'
Write-Host '  npx supabase functions deploy create-pix-charge'
Write-Host '  npx supabase functions deploy pix-webhook --no-verify-jwt'
