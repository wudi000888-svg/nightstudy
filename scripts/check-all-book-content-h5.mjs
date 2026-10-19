/** Anonymous Chromium acceptance; real DOM, network, MP3 playback, no scoring. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: Object.fromEntries(
  ['http-receipt', 'playwright-module', 'output'].map(name => [name, { type: 'string' }]),
), strict: true });
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
need(['http-receipt', 'playwright-module', 'output'].every(name => values[name]), 'explicit_h5_inputs');
need(process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux', 'cloud_browser_only');
const input = fs.readFileSync(values['http-receipt']);
need(input.length < 4 * 1024 ** 2, 'bounded_http_receipt');
const prior = JSON.parse(input), base = new URL(prior.baseUrl);
need(prior.kind === 'nightstudy-all-book-content-http-v1' && prior.passed === true && prior.anonymous === true &&
  prior.samples.length === 18 && new Set(prior.samples.map(s => s.bookId)).size === 18 &&
  base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'real_complete_isolated_http_receipt');
const out = path.resolve(values.output);
need(!fs.existsSync(out) && fs.realpathSync(path.dirname(out)) === path.dirname(out), 'fresh_h5_output');
fs.mkdirSync(out, { mode: 0o700 });
const receipt = { kind: 'nightstudy-all-book-content-h5-v1', startedAt: new Date().toISOString(),
  httpReceiptSha256: crypto.createHash('sha256').update(input).digest('hex'), anonymous: true,
  browser: 'Chromium', checks: [], screenshots: [], playback: [], blockedWrites: [], failures: [],
  limitations: ['Desktop Chromium emulates mobile viewports; no physical iPhone, Safari or installed PWA certification.',
    'Every built-in book has a DOM sample outside the original 35 words; two sentences have real US/UK playback.'] };
const { chromium } = await import(pathToFileURL(path.resolve(values['playwright-module'])).href);
const browser = await chromium.launch({ headless: true });
function check(code, condition) { receipt.checks.push({ code, passed: !!condition }); need(condition, code); }
const normalize = s => s.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const equal = (actual, expected) => normalize(actual) === normalize(expected);
async function setup(options) {
  const context = await browser.newContext({ ...options, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const r = route.request(), url = new URL(r.url());
    if (url.origin === base.origin && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) {
      receipt.blockedWrites.push({ method: r.method(), pathname: url.pathname }); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    window.__nightstudyRealPlayback = [];
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      const media = this;
      media.addEventListener('playing', () => window.__nightstudyRealPlayback.push({
        src: media.currentSrc, readyState: media.readyState, duration: media.duration,
      }), { once: true });
      return original.apply(media, args);
    };
  });
  return { context, page: await context.newPage() };
}
async function open(page, sample) {
  const url = new URL('lookup', base);
  url.search = new URLSearchParams({ q: sample.lemma, entry: sample.wordId, sense: sample.senseId }).toString();
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const detail = page.getByRole('region', { name: '词条详情', exact: true });
  await detail.locator('.study-meaning-browser').waitFor({ state: 'visible', timeout: 30000 });
  return detail;
}
async function exactContext(detail, sample, index) {
  const area = detail.locator('.study-context-sentence');
  await area.locator('.example-en').waitFor({ state: 'visible' });
  check('meaning_specific_english_context', equal(await area.locator('.example-en').innerText(), sample.examples[index].english));
  check('meaning_specific_chinese_context', equal(await area.locator('.example-zh').innerText(), sample.examples[index].chinese));
}
async function layout(page, name) {
  check(name + '_no_document_horizontal_overflow', await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
}
async function screenshot(page, name) {
  const fileName = name + '.png'; await page.screenshot({ path: path.join(out, fileName), fullPage: false });
  receipt.screenshots.push(fileName);
}
try {
  const { context, page } = await setup({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const [index, sample] of prior.samples.entries()) {
    const detail = await open(page, sample);
    const meaning = await detail.locator('.study-meaning-browser').innerText();
    check('new_book_sample_bilingual_definition', normalize(meaning).includes(normalize(sample.definitionEn)) && normalize(meaning).includes(normalize(sample.definitionZh)));
    check('new_book_sample_part_of_speech', (await detail.locator('.study-meaning-browser .study-meaning-topline .sense-pos').innerText()).includes(sample.pos));
    await exactContext(detail, sample, 0);
    await detail.getByRole('button', { name: '下一条例句', exact: true }).click();
    await exactContext(detail, sample, 1);
    await detail.getByRole('button', { name: '上一条例句', exact: true }).click();
    await exactContext(detail, sample, 0);
    await layout(page, 'book_' + index);
    if (index < 2) {
      const desired = sample.examples.findIndex(e => e.english === sample.audioText);
      for (let step = 0; step < desired; step++) await detail.getByRole('button', { name: '下一条例句', exact: true }).click();
      for (const [accent, label] of [['US', '美式'], ['UK', '英式']]) {
        const button = detail.getByRole('button', { name: `播放${label}例句朗读`, exact: true });
        await button.scrollIntoViewIfNeeded(); await button.waitFor({ state: 'visible', timeout: 30000 });
        await button.click({ timeout: 30000 });
        const expectedPath = `/api/v2/sentence-audio/${sample.textHash}/audio/${accent}`;
        await page.waitForFunction(p => window.__nightstudyRealPlayback.some(e =>
          new URL(e.src).pathname.endsWith(p) && e.readyState >= 2 && e.duration > 0), expectedPath, { timeout: 30000 });
        receipt.playback.push({ bookId: sample.bookId, textHash: sample.textHash, accent, actualPlayingEvent: true });
      }
      await screenshot(page, 'mobile-book-' + (index + 1));
    }
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await open(page, prior.samples[0]); await layout(page, 'small_mobile'); await screenshot(page, 'small-mobile');
  await context.close();
  const desktop = await setup({ viewport: { width: 1280, height: 800 } });
  const detail = await open(desktop.page, prior.samples[0]);
  const token = detail.locator('.study-context-sentence .word-token').first();
  await token.hover();
  const card = desktop.page.getByRole('dialog'); await card.waitFor({ state: 'visible', timeout: 30000 });
  check('hover_card_has_no_recursive_word_triggers', await card.locator('.word-token').count() === 0);
  const pin = card.getByRole('button', { name: '固定词卡', exact: true });
  await pin.hover();
  await card.getByRole('tooltip', { name: '固定卡片', exact: true }).waitFor({ state: 'visible' });
  check('pin_has_function_tooltip', true);
  await pin.click();
  await card.getByRole('button', { name: '取消固定词卡', exact: true }).waitFor({ state: 'visible' });
  await card.getByRole('button', { name: '关闭词卡，返回原文', exact: true }).click();
  await card.waitFor({ state: 'hidden' }); await screenshot(desktop.page, 'desktop-lookup');
  await desktop.context.close();
  check('no_business_write_attempts', receipt.blockedWrites.length === 0);
  receipt.passed = true;
} catch (error) { receipt.passed = false; receipt.failures.push(String(error.stack || error)); process.exitCode = 1; }
finally { await browser.close(); }
receipt.completedAt = new Date().toISOString();
fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks.length, actualPlayingEvents: receipt.playback.length, failures: receipt.failures }));
