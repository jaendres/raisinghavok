# One-time bootstrap: lets GitHub Actions deploy via OIDC (no stored passwords).
# Creates an Entra app registration + federated credential for this repo,
# grants it Contributor on the resource group, and stores the three IDs as
# GitHub Actions secrets. Idempotent -- safe to re-run.
#
#   .\scripts\setup-azure-oidc.ps1

$ErrorActionPreference = 'Stop'
$RepoFullName = 'jaendres/raisinghavok'
$AppRegName   = 'gh-raisinghavok-deploy'
$ResourceGroup = 'tcg-business-rg'

$sub = az account show --query id -o tsv
$tenant = az account show --query tenantId -o tsv

# app registration (reuse if it exists)
$appId = az ad app list --display-name $AppRegName --query "[0].appId" -o tsv
if (-not $appId) {
  $appId = az ad app create --display-name $AppRegName --query appId -o tsv
  Write-Host "Created app registration $AppRegName ($appId)"
}

# service principal
$spId = az ad sp list --filter "appId eq '$appId'" --query "[0].id" -o tsv
if (-not $spId) {
  $spId = az ad sp create --id $appId --query id -o tsv
}

# federated credential for pushes to main
$fedName = 'github-main'
$existing = az ad app federated-credential list --id $appId --query "[?name=='$fedName'] | length(@)" -o tsv
if ($existing -eq '0') {
  $cred = @{
    name = $fedName
    issuer = 'https://token.actions.githubusercontent.com'
    subject = "repo:${RepoFullName}:ref:refs/heads/main"
    audiences = @('api://AzureADTokenExchange')
  } | ConvertTo-Json -Compress
  $tmp = New-TemporaryFile
  Set-Content -Path $tmp -Value $cred -Encoding utf8
  az ad app federated-credential create --id $appId --parameters "@$tmp" --output none
  Remove-Item $tmp
  Write-Host "Added federated credential for $RepoFullName (main)"
}

# Contributor on the resource group (needed for bicep deploy + zip deploy).
# Use the object id -- assigning by appId right after SP creation can fail on
# Graph propagation delay.
az role assignment create --assignee-object-id $spId --assignee-principal-type ServicePrincipal `
  --role Contributor --scope "/subscriptions/$sub/resourceGroups/$ResourceGroup" --output none

# GitHub Actions secrets
gh secret set AZURE_CLIENT_ID --repo $RepoFullName --body $appId
gh secret set AZURE_TENANT_ID --repo $RepoFullName --body $tenant
gh secret set AZURE_SUBSCRIPTION_ID --repo $RepoFullName --body $sub

Write-Host "Done. Push to main to deploy."
