// A short-lived credential consumer. Never log Playwright errors or field values.
const fs = require('fs');
const origins = new Set(['https://auth.openai.com', 'https://auth.chatgpt.com', 'https://chatgpt.com']);
const selectors = {
  email: 'input[type="email"], input[name="username"]',
  password: 'input[type="password"]',
  totp: 'input[autocomplete="one-time-code"], input[name="code"], input[name="otp"]',
};
async function step(page, kind, value, allowed = origins) {
  if (!allowed.has(new URL(page.url()).origin)) throw new Error('Unapproved login origin');
  if (!value || value.startsWith('pass://')) throw new Error('Credential unavailable');
  const field = page.locator(selectors[kind]).filter({visible:true}).first();
  await field.waitFor({state:'visible',timeout:5000});
  // Recheck after waiting: redirects must never receive the credential.
  if (!allowed.has(new URL(page.url()).origin)) throw new Error('Origin changed');
  await field.fill(value,{timeout:5000});
  await page.getByRole('button',{name:/^(Continue|Next|Log in|Sign in|Verify|Submit)$/i}).first().click({timeout:5000});
}
async function main() {
  if (process.argv[2] === 'verify') {
    const expected = process.env.DEVTOOLS_CODEX_EXPECTED_EMAIL || process.env.DEVTOOLS_CODEX_VAULT_EMAIL || process.env.DEVTOOLS_CODEX_VAULT_USERNAME;
    const actual = process.env.DEVTOOLS_LOGIN_VALUE;
    if (!expected || !actual || expected.startsWith('pass://') || actual.startsWith('pass://') || expected.trim().toLowerCase() !== actual.trim().toLowerCase()) throw new Error('Login identity does not match the configured account');
    return;
  }
  const cfg = JSON.parse(fs.readFileSync(process.env.DEVTOOLS_BROWSER_CONFIG || process.env.HOME+'/.config/dev-tools/browser.json'));
  const {chromium} = require(cfg.runtime+'/node_modules/playwright');
  const browser = await chromium.connectOverCDP(process.env.DEVTOOLS_LOGIN_CDP);
  try {
    const kind = process.argv[2];
    if (!Object.hasOwn(selectors,kind)) throw new Error('Unknown stage');
    await step(browser.contexts()[0].pages()[0],kind,process.env.DEVTOOLS_LOGIN_VALUE);
  } finally { await browser.close(); }
}
module.exports = {step,selectors,origins};
if (require.main === module) main().catch(()=>{console.error('Automatic login step could not complete.');process.exitCode=1;});
