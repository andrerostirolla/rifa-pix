# Deploy das functions PIX + lembrete da migration SQL.
# Uso (PowerShell, pasta RifaPIX):
#   .\scripts\deploy-pix-functions.ps1

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
$ref = 'lkoumlpmkubgpjbqyipt'

Write-Host 'Deploy edge functions (via npx supabase)...'
npx supabase functions deploy create-pix-charge-workspace --project-ref $ref --no-verify-jwt
npx supabase functions deploy check-pix-charge-workspace --project-ref $ref --no-verify-jwt
npx supabase functions deploy list-pix-charges-workspace --project-ref $ref --no-verify-jwt
npx supabase functions deploy pix-webhook --project-ref $ref --no-verify-jwt

Write-Host ''
Write-Host 'OK functions.'
Write-Host 'Ainda falta rodar no SQL Editor do Supabase o arquivo:'
Write-Host '  supabase/migrations/20260826120000_pix_charges_state_sync.sql'
Write-Host ''
