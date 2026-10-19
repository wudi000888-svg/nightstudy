/** Anonymous Chromium acceptance; real DOM, network, MP3 playback, no scoring. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: Object.fromEntries(
    ['http-receipt', 'playwright-module', 'base-url', 'output'].map((name) => [
      name,
      { type: 'string' },
    ]),
  ),
  strict: true,
});
const need = (ok, reason) => {
  if (!ok) throw new Error(reason);
};
need(
  ['http-receipt', 'playwright-module', 'base-url', 'output'].every((name) => values[name]),
  'explicit_h5_inputs',
);
need(process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux', 'cloud_browser_only');
const input = fs.readFileSync(values['http-receipt']);
need(input.length < 4 * 1024 ** 2, 'bounded_http_receipt');
const prior = JSON.parse(input),
  checkedBase = new URL(prior.baseUrl),
  base = new URL(values['base-url']);
need(
  prior.kind === 'nightstudy-all-book-content-http-v1' &&
    prior.passed === true &&
    prior.anonymous === true &&
    prior.samples.length === 18 &&
    new Set(prior.samples.map((s) => s.bookId)).size === 18 &&
    [checkedBase, base].every(
      (url) =>
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
    ) &&
    base.pathname === checkedBase.pathname,
  'real_complete_isolated_http_receipt',
);
const out = path.resolve(values.output);
need(
  !fs.existsSync(out) && fs.realpathSync(path.dirname(out)) === path.dirname(out),
  'fresh_h5_output',
);
fs.mkdirSync(out, { mode: 0o700 });
const receipt = {
  kind: 'nightstudy-all-book-content-h5-v1',
  startedAt: new Date().toISOString(),
  httpReceiptSha256: crypto.createHash('sha256').update(input).digest('hex'),
  browserBaseUrl: base.href,
  checkedApplicationBaseUrl: checkedBase.href,
  anonymous: true,
  browser: 'Chromium',
  checks: [],
  screenshots: [],
  playback: [],
  blockedWrites: [],
  failures: [],
  limitations: [
    'Desktop Chromium emulates mobile viewports; no physical iPhone, Safari or installed PWA certification.',
    'Every built-in book has a DOM sample outside the original 35 words; two sentences have real US/UK playback.',
  ],
};
const { chromium } = await import(pathToFileURL(path.resolve(values['playwright-module'])).href);
const browser = await chromium.launch({ headless: true });
function check(code, condition) {
  receipt.checks.push({ code, passed: !!condition });
  need(condition, code);
}
const normalize = (s) => s.replace(/\\r\\n/g, '\n').replace(/\\[rn]/g, '\n').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const equal = (actual, expected) => normalize(actual) === normalize(expected);
async function setup(options) {
  const context = await browser.newContext({
    ...options,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.route('**/*', async (route) => {
    const r = route.request(),
      url = new URL(r.url());
    if (url.origin === base.origin && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) {
      receipt.blockedWrites.push({ method: r.method(), pathname: url.pathname });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    window.__nightstudyRealPlayback = [];
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      const media = this;
      media.addEventListener(
        'playing',
        () =>
          window.__nightstudyRealPlayback.push({
            src: media.currentSrc,
            readyState: media.readyState,
            duration: media.duration,
          }),
        { once: true },
      );
      return original.apply(media, args);
    };
  });
  return { context, page: await context.newPage() };
}
async function open(page, sample) {
  const url = new URL('lookup', base);
  url.search = new URLSearchParams({
    q: sample.lemma,
    entry: sample.wordId,
    sense: sample.senseId,
  }).toString();
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const detail = page.getByRole('region', { name: '词条详情', exact: true });
  await detail.locator('.study-meaning-browser').waitFor({ state: 'visible', timeout: 30000 });
  return detail;
}
async function exactContext(detail, sample, index) {
  const area = detail.locator('.study-context-sentence');
  await area.locator('.example-en').waitFor({ state: 'visible' });
  check(
    'meaning_specific_english_context',
    equal(await area.locator('.example-en').innerText(), sample.examples[index].english),
  );
  check(
    'meaning_specific_chinese_context',
    equal(await area.locator('.example-zh').innerText(), sample.examples[index].chinese),
  );
}
async function exactMeaning(detail, sample) {
  const meaning = detail.locator('.study-meaning-browser');
  const disclosures = meaning.locator('.bilingual-definition details.definition-disclosure');
  for (let index = 0; index < await disclosures.count(); index++) {
    const disclosure = disclosures.nth(index);
    if (!(await disclosure.evaluate((element) => element.open)))
      await disclosure.locator('summary .definition-toggle').click();
  }
  const english = meaning.locator('.bilingual-definition p.meaning-en');
  const chinese = meaning.locator('.bilingual-definition p.meaning-zh');
  await english.waitFor({ state: 'visible' });
  await chinese.waitFor({ state: 'visible' });
  check('new_book_sample_english_definition', equal(await english.innerText(), sample.definitionEn));
  check('new_book_sample_chinese_definition', equal(await chinese.innerText(), sample.definitionZh));
  const shownPos = normalize(await meaning.locator('.study-meaning-topline .sense-pos').innerText());
  const posParts = shownPos.split(' · ');
  check('new_book_sample_part_of_speech', !!sample.pos.trim() &&
    (shownPos === sample.pos.trim() || (posParts.length === 2 &&
      posParts[0].toLowerCase() === normalize(sample.lemma).toLowerCase() && posParts[1] === sample.pos.trim())));
}
async function layout(page, name) {
  check(
    name + '_no_document_horizontal_overflow',
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  );
  const measurements = await page.getByRole('region', { name: '词条详情', exact: true }).evaluate((entry) => {
    const screen = entry.closest('.h5-screen-content');
    const active = entry.closest('.h5-screen');
    if (!screen || !active || active.hidden || active.dataset.screenActive === 'false')
      return { validScreen: false, containers: [], controls: [] };
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, right = left + (viewport?.width ?? window.innerWidth);
    const top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? window.innerHeight);
    const bounds = screen.getBoundingClientRect(), clipLeft = Math.max(left, bounds.left), clipRight = Math.min(right, bounds.right);
    const visible = (node) => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
        !node.closest('[hidden],[inert]');
    };
    // These are normal-flow content containers, not the intentionally scrollable
    // sense directory/tabs or clamped text previews. Never test every descendant.
    const nodes = [screen, entry, ...entry.querySelectorAll('.study-meaning-browser,.study-context-body,.study-context-sentence')];
    const containers = nodes.filter(visible).map((node) => {
      const rect = node.getBoundingClientRect();
      return { name: node.className, horizontalContentFits: node.scrollWidth <= node.clientWidth + 2,
        horizontalBoundsFit: rect.left >= clipLeft - 2 && rect.right <= clipRight + 2 };
    });
    const controls = [...entry.querySelectorAll('.study-meaning-controls button,.study-context-arrows button,.sentence-audio-controls button,.word-header-action')]
      .filter(visible).filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > top && rect.top < bottom;
      }).map((node) => {
        const rect = node.getBoundingClientRect();
        return { name: node.getAttribute('aria-label') || node.className,
          horizontalBoundsFit: rect.left >= clipLeft - 2 && rect.right <= clipRight + 2 };
      });
    return { validScreen: true, containers, controls };
  });
  check(name + '_active_content_containers_fit', measurements.validScreen && measurements.containers.length >= 4 &&
    measurements.containers.every((entry) => entry.horizontalContentFits && entry.horizontalBoundsFit));
  check(name + '_visible_controls_fit', measurements.controls.every((entry) => entry.horizontalBoundsFit));
  receipt.layout ??= [];
  receipt.layout.push({ name, ...measurements });
}
async function screenshot(page, name) {
  const fileName = name + '.png';
  await page.screenshot({ path: path.join(out, fileName), fullPage: false });
  receipt.screenshots.push(fileName);
}
try {
  const { context, page } = await setup({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  for (const [index, sample] of prior.samples.entries()) {
    const detail = await open(page, sample);
    await exactMeaning(detail, sample);
    await exactContext(detail, sample, 0);
    await detail.getByRole('button', { name: '下一条例句', exact: true }).click();
    await exactContext(detail, sample, 1);
    await detail.getByRole('button', { name: '上一条例句', exact: true }).click();
    await exactContext(detail, sample, 0);
    await layout(page, 'book_' + index);
    if (index < 2) {
      const desired = sample.examples.findIndex((e) => e.english === sample.audioText);
      check('playback_example_is_in_current_meaning', desired >= 0);
      for (let step = 0; step < desired; step++)
        await detail.getByRole('button', { name: '下一条例句', exact: true }).click();
      await exactContext(detail, sample, desired);
      // Source lookup is IntersectionObserver-driven. Scroll the always-present
      // controls before waiting for the ready-only accessible button label.
      const controls = detail.locator('.study-context-sentence .sentence-audio-controls');
      await controls.waitFor({ state: 'visible' });
      await controls.scrollIntoViewIfNeeded();
      for (const [accent, label] of [
        ['US', '美式'],
        ['UK', '英式'],
      ]) {
        const button = detail.getByRole('button', { name: `播放${label}例句朗读`, exact: true });
        await button.scrollIntoViewIfNeeded();
        await button.waitFor({ state: 'visible', timeout: 30000 });
        const before = await page.evaluate(() => window.__nightstudyRealPlayback.length);
        await button.click({ timeout: 30000 });
        const expectedPath = `/api/v2/sentence-audio/${sample.textHash}/audio/${accent}`;
        await page.waitForFunction(
          ({ pathname, after }) =>
            window.__nightstudyRealPlayback.slice(after).some(
              (e) => new URL(e.src).pathname.endsWith(pathname) && e.readyState >= 2 && e.duration > 0,
            ),
          { pathname: expectedPath, after: before },
          { timeout: 30000 },
        );
        receipt.playback.push({
          bookId: sample.bookId,
          textHash: sample.textHash,
          accent,
          actualPlayingEvent: true,
        });
        await layout(page, 'playing_' + index + '_' + accent);
      }
      await screenshot(page, 'mobile-book-' + (index + 1));
    }
  }
  await page.setViewportSize({ width: 320, height: 568 });
  const smallDetail = await open(page, prior.samples[0]);
  await exactMeaning(smallDetail, prior.samples[0]);
  await smallDetail.locator('.study-meaning-browser').scrollIntoViewIfNeeded();
  await layout(page, 'small_mobile');
  await screenshot(page, 'small-mobile');
  await context.close();
  const desktop = await setup({ viewport: { width: 1280, height: 800 } });
  const detail = await open(desktop.page, prior.samples[0]);
  const tokens = detail.locator('.study-context-sentence .word-token');
  const tokenTexts = await tokens.allTextContents();
  const headwordIndex = tokenTexts.findIndex((text) => normalize(text).toLowerCase() === normalize(prior.samples[0].lemma).toLowerCase());
  const token = tokens.nth(headwordIndex >= 0 ? headwordIndex : 0);
  const queried = await token.innerText();
  const resolution = desktop.page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.origin === base.origin &&
      url.pathname.endsWith('/api/v2/dictionary/resolve') && url.searchParams.get('text') === queried;
  }, { timeout: 30000 });
  await token.hover();
  const response = await resolution;
  const resolved = await response.json();
  check('desktop_hover_resolves_real_word', response.status() === 200 && resolved.word?.id &&
    resolved.matchType === 'exact' && normalize(resolved.queried).toLowerCase() === normalize(queried).toLowerCase());
  const card = desktop.page.getByRole('dialog');
  await card.waitFor({ state: 'visible', timeout: 30000 });
  const content = card.locator('.word-card-quick-content');
  await content.waitFor({ state: 'visible', timeout: 30000 });
  const heading = normalize(await card.locator('.word-card-heading h2').innerText());
  const definitions = (resolved.word.senses?.length ? resolved.word.senses : resolved.word.dictionarySenses ?? [])
    .flatMap((sense) => [sense.definitionEn, sense.definitionZh]).filter((value) => typeof value === 'string' && value.trim());
  const actualContent = normalize(await content.innerText());
  check('desktop_hover_heading_and_resolved_content', heading.length > 0 &&
    heading.split(' / ').every((value) => value.toLowerCase() === normalize(resolved.word.lemma).toLowerCase()) &&
    definitions.some((value) => actualContent.includes(normalize(value))) && await content.locator('.word-card-quick-meaning').count() > 0);
  receipt.desktopHover = { queried, wordId: resolved.word.id, lemma: resolved.word.lemma, heading,
    realLookupResponse: true, resolvedContentVisible: true };
  check(
    'hover_card_has_no_recursive_word_triggers',
    (await card.locator('.word-token').count()) === 0,
  );
  const pin = card.getByRole('button', { name: '固定词卡', exact: true });
  await pin.hover();
  await card.getByRole('tooltip', { name: '固定卡片', exact: true }).waitFor({ state: 'visible' });
  check('pin_has_function_tooltip', true);
  await pin.click();
  await card
    .getByRole('button', { name: '取消固定词卡', exact: true })
    .waitFor({ state: 'visible' });
  await card.getByRole('button', { name: '关闭词卡，返回原文', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  await screenshot(desktop.page, 'desktop-lookup');
  await desktop.context.close();
  check('no_business_write_attempts', receipt.blockedWrites.length === 0);
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.failures.push(String(error.stack || error));
  process.exitCode = 1;
} finally {
  await browser.close();
}
receipt.completedAt = new Date().toISOString();
fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
console.log(
  JSON.stringify({
    passed: receipt.passed,
    checks: receipt.checks.length,
    actualPlayingEvents: receipt.playback.length,
    failures: receipt.failures,
  }),
);
