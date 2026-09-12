// Snapshot the GNU Radio wiki's page-per-block documentation into blocks/wiki/,
// where editor/gen/gen_knowledge.mjs indexes it for Graham's search_docs.
//
// Usage: node scripts/fetch-wiki-block-docs.mjs --dump=<pages.xml>            # from a MediaWiki XML export
//        node scripts/fetch-wiki-block-docs.mjs [--headed] [--refresh] [--chrome=<path>] [--only=<block id>]
//
// The dump route is the one to prefer: a MediaWiki XML export (Special:Export
// of Category:Block Docs, or `php maintenance/dumpBackup.php --current` on the
// wiki host) holds every page in one file, needs no browser and no bot-check
// clearance, and is what a wiki admin can produce in a minute. The same block
// -> page mapping and conversion apply, and the output is identical.
//
// Resumable: a block whose page is already under blocks/wiki/ is skipped, so a
// run the bot check interrupted -- it re-challenges a session every hundred or
// two pages -- picks up where it stopped when rerun. `--refresh` refetches
// everything, for when the wiki has moved on.
//
// The wiki sits behind a Cloudflare managed challenge that plain HTTP clients
// and headless browsers fail, so this drives a real Chrome with a persistent
// profile under .cache/wiki-profile/. The first run needs `--headed`: a window
// opens, you pass the challenge once, and the clearance cookie stays in that
// profile for the headless runs after it. `--headed` needs a full Chrome, not
// the headless shell the tests use:
//
//   npx @puppeteer/browsers install chrome@stable --path "$PWD"   # -> ./chrome/
//
// That is a *Linux* Chrome, on WSL shown through WSLg. The Windows install is
// deliberately never used: puppeteer talks to Chrome over a pipe or a local
// port, and neither crosses the WSL/Windows boundary -- the process exits with
// "Remote debugging pipe file descriptors are not open" and puppeteer reports
// only "Failed to launch the browser process". A system Chrome on PATH works
// too, or name one with `--chrome=`. Pages are fetched through MediaWiki's
// `action=raw`, one request at a time with a pause between them.
//
// The snapshot is committed, deliberately: it changes rarely, the wiki is a
// community resource that should not see ~550 requests per CI build, and a
// pinned snapshot keeps the generated index deterministic. Rerun this when the
// wiki has moved on. Every page is CC BY-SA 4.0, and each file's header keeps
// its URL so a retrieved excerpt can cite it.
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome } from './browser-test-support.mjs';
import { wikitextToText } from './wikitext.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'blocks', 'wiki');
const PROFILE = join(ROOT, '.cache', 'wiki-profile');
const PAUSE_MS = 1200;

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const refresh = args.includes('--refresh');
const dump = args.find(arg => arg.startsWith('--dump='))?.slice('--dump='.length);
const only = args.find(arg => arg.startsWith('--only='))?.slice('--only='.length);

const library = JSON.parse(await readFile(join(ROOT, 'editor', 'public', 'blocks.json'), 'utf8'));
const blocks = (library.blocks || [])
  .filter(block => block.runnable && block.wiki_url && (!only || block.id === only));
if (!blocks.length) {
  console.error('no runnable block with a wiki_url in editor/public/blocks.json (run `npm run blocks` in editor/)');
  process.exit(2);
}

const pageTitle = block => decodeURIComponent(new URL(block.wiki_url).pathname.split('/').pop() || '');

/** Write one block's page, from wikitext, the way both routes do. */
async function writePage(block, title, wikitext) {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, `${block.id}.md`), [
    `<!-- block: ${block.id} -->`,
    `<!-- title: ${title.replace(/_/g, ' ')} -->`,
    `<!-- source: ${block.wiki_url} -->`,
    `<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->`,
    `<!-- fetched: ${new Date().toISOString().slice(0, 10)} -->`,
    '',
    wikitextToText(wikitext),
    '',
  ].join('\n'));
}

/**
 * Pages out of a MediaWiki XML export: <page><title>…</title>…<revision>…
 * <text>…</text></revision></page>, the last revision of each. A streaming
 * parser is not needed -- the whole wiki's current text is a few megabytes.
 */
export function pagesFromDump(xml) {
  const decode = text => text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
  const pages = new Map();
  for (const match of xml.matchAll(/<page>([\s\S]*?)<\/page>/g)) {
    const body = match[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(body)?.[1];
    if (!title) continue;
    const texts = [...body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
    if (!texts.length) continue;
    pages.set(decode(title).trim(), decode(texts.at(-1)[1]));
  }
  return pages;
}

if (dump) {
  const xml = await readFile(dump, 'utf8');
  const pages = pagesFromDump(xml);
  if (!pages.size) { console.error(`${dump}: no <page> entries -- is it a MediaWiki XML export?`); process.exit(2); }
  let written = 0, absent = 0;
  const byTitle = new Map([...pages].map(([title, text]) => [title.replace(/ /g, '_'), text]));
  for (const block of blocks) {
    // The recorded wiki_url first, then the block's own label, which is what
    // the wiki titles a page by when the two disagree ("Multiply Const").
    const candidates = [pageTitle(block), String(block.label || '').trim().replace(/ /g, '_')]
      .filter(Boolean);
    const title = candidates.find(name => byTitle.has(name)) ?? candidates[0];
    const text = byTitle.get(title);
    if (text === undefined) { absent++; continue; }
    // A redirect page says where the real one is; follow it once.
    const redirect = /^#REDIRECT\s*\[\[([^\]|]+)/i.exec(text.trim());
    const resolved = redirect ? byTitle.get(redirect[1].trim().replace(/ /g, '_')) : text;
    if (resolved === undefined) { absent++; continue; }
    await writePage(block, title, resolved);
    written++;
  }
  console.log(`wrote ${written} page(s) into blocks/wiki/ from ${dump} (${pages.size} pages in the dump); ` +
    `${absent} runnable block(s) have no page in it`);
  process.exit(0);
}

const named = args.find(arg => arg.startsWith('--chrome='))?.slice('--chrome='.length);
/** The full Chrome for Testing under ./chrome/, if installed, else a system one. */
function findFullChrome() {
  const base = join(ROOT, 'chrome');
  const local = existsSync(base)
    ? readdirSync(base).sort().reverse()
        .map(version => join(base, version, 'chrome-linux64', 'chrome'))
    : [];
  return [...local, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
}
const executablePath = named || findFullChrome() ||
  (headed ? undefined : findChrome(ROOT, { allowWindows: false }));
if (!executablePath) {
  console.error(headed
    ? 'a full Linux Chrome is needed for --headed. Install one with:\n' +
      '  npx @puppeteer/browsers install chrome@stable --path "$PWD"\n' +
      'or name one with --chrome=<path>.'
    : 'Chrome not found. Install it with: npx @puppeteer/browsers install chrome@stable --path "$PWD"');
  process.exit(2);
}
await mkdir(OUT, { recursive: true });
await mkdir(PROFILE, { recursive: true });
const browser = await puppeteer.launch({
  executablePath, headless: !headed, userDataDir: PROFILE,
  // --no-sandbox: Chrome for Testing has no setuid sandbox on most WSL and
  // container kernels, and a headed window through WSLg needs a real GPU no
  // more than the headless shell does. The automation banner and
  // navigator.webdriver are switched off because the bot check reads both, and
  // with them on its widget verifies, fails and reloads in a loop nobody can
  // click into.
  args: ['--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu',
         '--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
// The clearance the headed run earned is bound to the user agent, and a
// headless Chrome calls itself HeadlessChrome -- a different browser, as far
// as the check is concerned, so the cookie would not apply. Same binary, same
// name. A tab is opened on demand: the one on screen may be closed by the
// person passing the check, which puppeteer reports as a detached frame.
let page = null;
const tab = async () => {
  if (page && !page.isClosed()) return page;
  page = await browser.newPage();
  await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
  return page;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHALLENGE = /Just a moment|Performing security verification/;
/** Whether the page on screen is the bot check rather than the wiki's answer. */
const onChallenge = async () => (await tab()).evaluate(
  () => /Just a moment|Performing security verification/.test(document.title + ' ' + document.body.innerText.slice(0, 400)));

// The wiki's answer, through the API rather than `action=raw`: JSON renders as
// text in a tab, where text/x-wiki may be offered as a download instead.
const pageUrl = title => 'https://wiki.gnuradio.org/api.php?action=parse&prop=wikitext&format=json' +
  `&formatversion=2&page=${encodeURIComponent(title)}`;

let fetched = 0, missing = 0, skipped = 0, blocked = false;
try {
  for (const block of blocks) {
    const title = pageTitle(block);
    if (!title) continue;
    if (!refresh && !only && existsSync(join(OUT, `${block.id}.md`))) { skipped++; continue; }
    let response;
    try {
      response = await (await tab()).goto(pageUrl(title), { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (error) {
      if (!/detached|closed|Target closed/i.test(String(error))) throw error;
      page = null;   // the tab went away; the next tab() opens another
      response = await (await tab()).goto(pageUrl(title), { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    let status = response?.status() ?? 0;
    if (status === 403 && headed) {
      // Once the check is passed the challenge page navigates to the requested
      // URL by itself, so this only watches -- reloading here would reset the
      // widget under the reader's cursor every time.
      console.log('pass the Cloudflare check in the browser window; waiting up to three minutes…');
      const started = Date.now();
      while (Date.now() - started < 180_000) {
        await sleep(1000);
        let challenged = true;
        try { challenged = await onChallenge(); } catch { /* mid-navigation */ }
        if (!challenged) { status = 200; break; }
      }
    }
    if (status === 403) {
      console.error(`${title}: 403 — the wiki's bot check refused this session. Rerun with --headed and pass it once.`);
      blocked = true;
      break;
    }
    if (status !== 200) { console.log(`${block.id}: HTTP ${status} for ${title}`); await sleep(PAUSE_MS); continue; }
    const body = await (await tab()).evaluate(() => document.body.innerText);
    if (CHALLENGE.test(body.slice(0, 400))) {
      console.error(`${title}: the bot check came back. Rerun with --headed and pass it once.`);
      blocked = true;
      break;
    }
    let answer;
    try { answer = JSON.parse(body); }
    catch { console.log(`${block.id}: unreadable answer for ${title}`); await sleep(PAUSE_MS); continue; }
    if (answer.error?.code === 'missingtitle') {
      missing++; console.log(`${block.id}: no wiki page "${title}"`); await sleep(PAUSE_MS); continue;
    }
    const wikitext = answer.parse?.wikitext;
    if (typeof wikitext !== 'string') {
      console.log(`${block.id}: ${answer.error?.info || 'no wikitext'} for ${title}`); await sleep(PAUSE_MS); continue;
    }
    await writePage(block, title, wikitext);
    fetched++;
    await sleep(PAUSE_MS);
  }
} finally {
  await browser.close();
}
console.log(`fetched ${fetched} page(s) into blocks/wiki/, ${missing} block(s) without a page` +
  (skipped ? `, ${skipped} already there` : ''));
if (blocked) { console.error('stopped early; rerun to continue from here'); process.exit(1); }
