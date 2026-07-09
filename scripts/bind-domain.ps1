# Bind raisinghavok.com to the app + issue the free App Service managed cert.
# Run AFTER DNS is pointing at the app (A + TXT records -- see README).
# Managed certs can only be created once the hostname resolves, which is why
# this step can't live in the Bicep template.
#
#   .\scripts\bind-domain.ps1
#   .\scripts\bind-domain.ps1 -Domain www.raisinghavok.com   # repeat for www if desired

param(
  [string]$Domain = 'raisinghavok.com',
  [string]$App = 'raisinghavok',
  [string]$ResourceGroup = 'tcg-business-rg'
)
$ErrorActionPreference = 'Stop'

az webapp config hostname add --webapp-name $App -g $ResourceGroup --hostname $Domain

# NOTE: on some CLI versions `ssl create` prints a harmless "failsafe" JSON
# deserialization error -- the cert is still created. Verify with the resource query below.
az webapp config ssl create -g $ResourceGroup -n $App --hostname $Domain 2>$null

$thumb = az resource list -g $ResourceGroup --resource-type Microsoft.Web/certificates `
  --query "[?contains(name, '$Domain')].properties.thumbprint | [0]" -o tsv
if (-not $thumb) { throw "Managed cert not found yet -- DNS may still be propagating. Re-run in a few minutes." }

az webapp config ssl bind -g $ResourceGroup -n $App --certificate-thumbprint $thumb --ssl-type SNI
Write-Host "https://$Domain is bound with a free managed certificate."
