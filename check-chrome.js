// scripts/check-chrome.js
const { execSync } = require('child_process');
const fs = require('fs');

console.log('🔍 Checking for Chrome installation...');

const chromePaths = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' // Windows
];

let found = false;
for (const path of chromePaths) {
  if (fs.existsSync(path)) {
    console.log(`✅ Chrome found at: ${path}`);
    found = true;
    break;
  }
}

if (!found) {
  console.log('⚠️ Chrome not found, attempting to install...');
  
  if (process.platform === 'linux') {
    try {
      console.log('Installing Chrome on Linux...');
      execSync('wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -', { stdio: 'inherit' });
      execSync('sh -c \'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list\'', { stdio: 'inherit' });
      execSync('apt-get update', { stdio: 'inherit' });
      execSync('apt-get install -y google-chrome-stable', { stdio: 'inherit' });
      console.log('✅ Chrome installed successfully');
    } catch (error) {
      console.error('❌ Failed to install Chrome:', error.message);
      process.exit(1);
    }
  } else {
    console.log('⚠️ Please install Chrome manually for PDF generation to work');
  }
}