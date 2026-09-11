# Publie une release du launcher sur GitHub.
#
# Le token n'est jamais tapé dans la console ni stocké dans le repo : il est lu
# depuis %USERPROFILE%\.krashland-gh-token et injecté uniquement dans ce process.
# Contrairement à setx, il n'est donc pas exposé à tous les autres programmes.
#
# Creation du fichier de token (une seule fois) :
#   Set-Content "$env:USERPROFILE\.krashland-gh-token" "github_pat_xxxxx" -NoNewline
#   icacls "$env:USERPROFILE\.krashland-gh-token" /inheritance:r /grant:r "${env:USERNAME}:(R)"
#
# Le token doit etre un fine-grained PAT limite au depot krashland-launcher,
# avec la permission Contents en Read and write.
#
# Usage :
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1

$ErrorActionPreference = 'Stop'

$tokenFile = Join-Path $env:USERPROFILE '.krashland-gh-token'

if (-not (Test-Path $tokenFile)) {
  Write-Host "Fichier de token introuvable : $tokenFile" -ForegroundColor Red
  Write-Host ""
  Write-Host "Cree-le avec (en remplacant par ton token) :"
  Write-Host "  Set-Content `"$tokenFile`" `"github_pat_xxxxx`" -NoNewline"
  exit 1
}

$token = (Get-Content $tokenFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Host "Le fichier de token est vide : $tokenFile" -ForegroundColor Red
  exit 1
}

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "Publication de la version $version sur GitHub..." -ForegroundColor Cyan

$env:GH_TOKEN = $token
try {
  npm run release:win
  if ($LASTEXITCODE -ne 0) { throw "electron-builder a echoue (code $LASTEXITCODE)" }
  Write-Host ""
  Write-Host "Release v$version publiee." -ForegroundColor Green
  Write-Host "https://github.com/ZKYXYKZ/krashland-launcher/releases/tag/v$version"
} finally {
  # Le token ne survit pas a ce process, mais on nettoie quand meme.
  Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
}
