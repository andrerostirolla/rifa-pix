# Sobe o RifaPIX local. Pede a anon key se .env estiver vazio.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
  @"
VITE_SUPABASE_URL=https://lkoumlpmkubgpjbqyipt.supabase.co
VITE_SUPABASE_ANON_KEY=
"@ | Set-Content $envFile -Encoding utf8
}

$content = Get-Content $envFile -Raw
if ($content -match 'VITE_SUPABASE_ANON_KEY=\s*$' -or $content -match 'VITE_SUPABASE_ANON_KEY=YOUR_') {
  Write-Host ''
  Write-Host 'Cole a anon public key do Supabase:'
  Write-Host '  Dashboard -> Settings -> API -> anon public'
  Write-Host '  https://supabase.com/dashboard/project/lkoumlpmkubgpjbqyipt/settings/api'
  Write-Host ''
  $anon = Read-Host 'VITE_SUPABASE_ANON_KEY'
  if ($anon) {
    $content = $content -replace 'VITE_SUPABASE_ANON_KEY=.*', "VITE_SUPABASE_ANON_KEY=$anon"
    Set-Content $envFile $content.TrimEnd() -Encoding utf8
  } else {
    Write-Host 'Sem anon key: app roda em modo LOCAL (demo), sem PIX na nuvem.'
  }
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host 'Instalando dependencias (npm install)...'
  npm install
}

Write-Host ''
Write-Host 'Abrindo em http://localhost:5173/rifa-pix/'
Write-Host 'Ctrl+C para parar.'
Write-Host ''
npm run dev
