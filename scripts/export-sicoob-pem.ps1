# Extrai cert.pem e key.pem do sicoob.pfx (ICP-Brasil A1).
# Rode na pasta RifaPIX:  .\scripts\export-sicoob-pem.ps1

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$pfxPath = Join-Path $root 'sicoob.pfx'
$certOut = Join-Path $root 'sicoob-cert.pem'
$keyOut  = Join-Path $root 'sicoob-key.pem'

if (-not (Test-Path $pfxPath)) {
  Write-Error "Arquivo nao encontrado: $pfxPath"
}

$openssl = 'C:\Program Files\Git\mingw64\bin\openssl.exe'
if (-not (Test-Path $openssl)) {
  Write-Error "OpenSSL nao encontrado em $openssl (instale Git for Windows ou OpenSSL)."
}

$env:OPENSSL_MODULES = 'C:\Program Files\Git\mingw64\lib\ossl-modules'

$pwdPlain = Read-Host 'Senha do arquivo .pfx' -AsSecureString
$pwdBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwdPlain)
try {
  $pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($pwdBstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pwdBstr)
}

Write-Host 'Extraindo certificado...'
& $openssl pkcs12 -legacy -in $pfxPath -clcerts -nokeys -passin "pass:$pass" -out $certOut
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Cadeia intermediaria (alguns endpoints Sicoob exigem)
$chainOut = Join-Path $root 'sicoob-chain.pem'
& $openssl pkcs12 -legacy -in $pfxPath -cacerts -nokeys -passin "pass:$pass" -out $chainOut 2>$null
if ($LASTEXITCODE -eq 0 -and (Test-Path $chainOut) -and (Get-Item $chainOut).Length -gt 100) {
  $leaf = Get-Content -Raw $certOut
  $chain = Get-Content -Raw $chainOut
  Set-Content -Path $certOut -Value ($leaf.TrimEnd() + "`n" + $chain.Trim()) -Encoding utf8
  Remove-Item $chainOut -Force
}

Write-Host 'Extraindo chave privada...'
& $openssl pkcs12 -legacy -in $pfxPath -nocerts -nodes -passin "pass:$pass" -out $keyOut
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Remove metadados "Bag Attributes" — só o bloco PEM
$keyRaw = Get-Content -Raw $keyOut
$begin = $keyRaw.IndexOf('-----BEGIN')
if ($begin -gt 0) {
  Set-Content -Path $keyOut -Value $keyRaw.Substring($begin).Trim() -NoNewline
  Add-Content -Path $keyOut -Value ''
}

$certLen = (Get-Item $certOut).Length
$keyLen  = (Get-Item $keyOut).Length

Write-Host ''
Write-Host "sicoob-cert.pem : $certLen bytes"
Write-Host "sicoob-key.pem  : $keyLen bytes"
Write-Host ''
Write-Host 'Primeira linha da chave:'
Get-Content $keyOut -TotalCount 1

if ($keyLen -lt 500) {
  Write-Error 'Chave ainda parece invalida (esperado > 500 bytes). Verifique a senha do .pfx.'
}

Write-Host ''
Write-Host 'OK. Proximo passo (na pasta RifaPIX):'
Write-Host '  npx supabase secrets set SICOOB_KEY_PEM="$(Get-Content -Raw .\sicoob-key.pem)"'
