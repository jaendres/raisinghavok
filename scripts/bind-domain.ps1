# Bind a hostname to the app + issue the free App Service managed cert.
# Run AFTER DNS is pointing at the app (A/CNAME + asuid TXT -- see README).
# Managed certs can only be created once the hostname resolves, which is why
# this step can't live in the Bicep template.
#
#   .\scripts\bind-domain.ps1
#   .\scripts\bind-domain.ps1 -Domain www.raisinghavok.com
#
# Gotchas this script works around (learned the hard way):
# - `az webapp config ssl create` emits a harmless "failsafe deserialization"
#   warning on stderr that PowerShell treats as fatal -- run via cmd /c.
# - Cert creation is async; poll until the certificate resource appears.
# - `az resource list` returns properties as null -- must `az resource show`
#   the specific id to read the thumbprint.

param(
  [string]$Domain = 'raisinghavok.com',
  [string]$App = 'raisinghavok',
  [string]$ResourceGroup = 'tcg-business-rg'
)
$ErrorActionPreference = 'Stop'

az webapp config hostname add --webapp-name $App -g $ResourceGroup --hostname $Domain --output none

cmd /c "az webapp config ssl create -g $ResourceGroup -n $App --hostname $Domain --output none 2>nul"
if ($LASTEXITCODE -ne 0) { throw "ssl create failed -- is DNS (A/CNAME + asuid TXT) propagated?" }

$certId = $null
foreach ($try in 1..20) {
  $certId = az resource list -g $ResourceGroup --resource-type Microsoft.Web/certificates `
    --query "[?name=='$Domain'] | [0].id" -o tsv
  if ($certId) { break }
  Write-Host "Waiting for managed cert... ($try/20)"
  Start-Sleep -Seconds 15
}
if (-not $certId) { throw "Managed cert never appeared -- check DNS and retry." }

$thumb = az resource show --ids $certId --query properties.thumbprint -o tsv
cmd /c "az webapp config ssl bind -g $ResourceGroup -n $App --certificate-thumbprint $thumb --ssl-type SNI --output none 2>nul"
if ($LASTEXITCODE -ne 0) { throw "ssl bind failed" }

Write-Host "https://$Domain is bound with a free managed certificate (thumbprint $thumb)."
