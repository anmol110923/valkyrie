const path = require('path')

module.exports = {
  PARTITION: 'persist:valkyrie',
  PAGES_DIR: path.join(__dirname, 'pages'),
  ICON_PNG: path.join(__dirname, '..', 'assets', 'icon.png'),
  NEWTAB_URL: 'valkyrie://newtab/',
  WELLBEING_URL: 'valkyrie://wellbeing/',
  SETTINGS_URL: 'valkyrie://settings/',
  SEARCH_URL: 'https://www.google.com/search?q=',
  WEB_STORE_URL: 'https://chromewebstore.google.com/',
  IDLE_SECONDS: 60, // stop counting screen time after a minute without input (unless audio plays)
}
