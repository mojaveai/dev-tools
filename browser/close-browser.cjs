// Graceful lifecycle shutdown through upstream Playwright: flush the profile
// before stopping its X server. Browser.close() on a CDP attachment alone only
// disconnects the client, so send Chromium's explicit Browser.close command.
const path = require('node:path');
const { chromium } = require(path.join(process.argv[2], 'node_modules/playwright'));
(async () => {
  const browser = await chromium.connectOverCDP(process.argv[3], { timeout: 3000 });
  const session = await browser.newBrowserCDPSession();
  await session.send('Browser.close');
  await browser.close();
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
