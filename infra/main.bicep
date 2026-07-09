// Raising Havok — infra as code.
// Deploys the web app onto the EXISTING shared App Service plan (tcg-business-plan,
// B1 Linux) so it adds zero hosting cost alongside jasonendres.me / tcgplayer / wh40k-bot.
//
//   az deployment group create -g tcg-business-rg -f infra/main.bicep
//
// Custom domain + managed cert are bound after DNS points at the app — see
// scripts/bind-domain.ps1 (managed certs can't be created until the hostname
// resolves, so that half stays a script by necessity).

param appName string = 'raisinghavok'
param planName string = 'tcg-business-plan'
param location string = resourceGroup().location

// reCAPTCHA v2 keys, injected from GitHub Actions secrets. IMPORTANT: this
// template owns the app-settings list — anything set manually in the portal
// gets wiped on the next deploy, so new settings must be added HERE.
param recaptchaSiteKey string = ''
@secure()
param recaptchaSecret string = ''

// Shared secret letting the Blood Bowl Discord bot post league match results.
@secure()
param leagueApiKey string = ''

// Comma-separated usernames with league admin rights (edit/delete anything).
param adminUsers string = 'Jason'

resource plan 'Microsoft.Web/serverfarms@2023-12-01' existing = {
  name: planName
}

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false // single instance; no ARR cookie needed for socket.io
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      appCommandLine: 'node server/index.js'
      alwaysOn: true          // free on B1; keeps the match server + websockets warm
      webSocketsEnabled: true // socket.io
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: [
        {
          name: 'DATA_DIR'
          value: '/home/data' // persistent storage — survives every deployment
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'false' // CI ships node_modules in the zip; no Oryx rebuild
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~20'
        }
        {
          name: 'RECAPTCHA_SITE_KEY'
          value: recaptchaSiteKey
        }
        {
          name: 'RECAPTCHA_SECRET'
          value: recaptchaSecret
        }
        {
          name: 'LEAGUE_API_KEY'
          value: leagueApiKey
        }
        {
          name: 'ADMIN_USERS'
          value: adminUsers
        }
      ]
    }
  }
}

output defaultHostName string = site.properties.defaultHostName
output inboundIp string = site.properties.inboundIpAddress
output customDomainVerificationId string = site.properties.customDomainVerificationId
