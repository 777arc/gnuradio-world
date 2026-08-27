#!/usr/bin/env node
// Generate a real, indexable HTML document for every example flowgraph.
//
// Why this exists: inside the editor an example is addressed by URL *fragment*
// (#example=analog/fm_loopback), and a fragment is not a URL a search engine can
// tell apart from the bare editor. So all 79 examples -- the most searchable
// content the site has, one per thing a person might actually type into Google
// -- were invisible, and the whole site was a single indexable page.
//
// The output is static: /examples/ (hub), /examples/<category>/ and
// /examples/<category>/<slug>/ (leaf). Not client-side routing, which Cloudflare
// Pages cannot serve anyway -- see the note on _redirects in
// scripts/assemble-site.mjs, where a wildcard 200-rewrite comes back as a 308
// and swallows the page's own assets.
//
// Written into editor/public/, so Vite copies it to dist/ and assemble-site.mjs
// carries it to the site root: the same path editor/public/blocks.json takes,
// and generated and git-ignored for the same reason.
//
// Usage: node editor/gen/gen_example_pages.mjs   (from anywhere)
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
// The tree's one helper for running editor TypeScript under Node. Shared with
// editor/test rather than duplicated: this generator must read a .grc through
// the very parser and summarizer the editor uses, or a page could describe a
// flowgraph differently from the palette entry beside it.
import { bundleModule } from '../test/bundle-module.mjs';
import { findExampleFlowgraphs } from '../../scripts/example-flowgraphs.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const EXAMPLES = join(ROOT, 'example_flowgraphs');
const PUBLIC = join(ROOT, 'editor', 'public');
const OUT = join(PUBLIC, 'examples');
const ORIGIN = 'https://gnuradioworld.com';
const REPO = 'https://github.com/777arc/gnuradio-world';

const { parseGrc } = await bundleModule('../src/grc.ts');
const catalog = await bundleModule('../src/example-catalog.ts');

// ---- helpers ---------------------------------------------------------------

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A meta description is truncated by Google at roughly 160 characters, so the
// sentence out of the .grc gets the invitation appended only when both fit.
const metaDescription = (sentence) => {
  // The .grc descriptions are written as labels, not sentences, so most end
  // without a full stop -- which would run straight into the invitation.
  const written = String(sentence || '').replace(/\s+/g, ' ').trim();
  const base = /[.!?]$/.test(written) ? written : written + '.';
  const tail = ' Run it in your browser — no install.';
  if (base.length + tail.length <= 160) return base + tail;
  return base.length <= 160 ? base : base.slice(0, 157).trimEnd() + '…';
};

// Directory name -> what a person calls that category. Anything unlisted is
// title-cased, and a gr-* module keeps its own name: "gr-satellites" is what
// someone searches for, not "Gr Satellites".
const CATEGORY_NAMES = {
  analog: 'Analog', audio: 'Audio', blocks: 'Blocks', channels: 'Channel Models',
  digital: 'Digital', droneid: 'DroneID', dtv: 'Digital Television',
  dvbs2: 'DVB-S2', filter: 'Filters', fosphor: 'fosphor', hackrf: 'HackRF',
  ham: 'Ham Radio', hrpt: 'HRPT', javascript: 'JavaScript Blocks', ofdm: 'OFDM',
  paint: 'Spectrum Painting', plutosdr: 'PlutoSDR', python: 'Embedded Python',
  qtgui: 'QT GUI', rds: 'RDS', recordings: 'Recordings', rtlsdr: 'RTL-SDR',
  wifi: 'Wi-Fi',
};
const categoryName = (dir) => CATEGORY_NAMES[dir]
  || (dir.startsWith('gr-') ? dir
      : dir.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));

const page = ({ title, description, canonical, jsonLd = [], body }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#181b26" />
<meta name="color-scheme" content="dark" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="GNU Radio World" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${ORIGIN}/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="${ORIGIN}/og-image.png" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon.ico" sizes="32x32" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="stylesheet" href="/examples.css" />
${jsonLd.map(data =>
  `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`).join('\n')}
</head>
<body>
<header>
  <a href="/" aria-label="GNU Radio World home">
    <img src="/gnuradio_world_logo_dark.svg" alt="GNU Radio World" />
  </a>
</header>
<main>
${body}
</main>
<footer>
  <a href="/">Open the editor</a><a href="/examples/">All examples</a><a href="${REPO}">GitHub</a><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a>
</footer>
</body>
</html>
`;

// The last step is the page itself, so it is text rather than a link.
const crumbs = (trail) => `<nav class="crumbs" aria-label="Breadcrumb">` +
  trail.map((step, i) => {
    const separator = i ? '<span aria-hidden="true">/</span>' : '';
    return separator + (step.url
      ? `<a href="${esc(step.url)}">${esc(step.name)}</a>`
      : `<b>${esc(step.name)}</b>`);
  }).join('') + `</nav>`;

const breadcrumbLd = (trail) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: trail.map((step, i) => ({
    '@type': 'ListItem', position: i + 1, name: step.name,
    item: ORIGIN + (step.url || step.self),
  })),
});

const cards = (entries) => `<ul class="cards">\n` + entries.map(entry =>
  `  <li><a href="${esc(entry.url)}"><strong>${esc(entry.title)}</strong>` +
  `<span>${esc(entry.blurb)}</span></a></li>`).join('\n') + `\n</ul>`;

// ---- read every example ----------------------------------------------------

const blockLibrary = await readFile(join(PUBLIC, 'blocks.json'), 'utf8').then(
  text => new Map(JSON.parse(text).blocks.map(block => [block.id, block])),
  () => {
    console.error('editor/public/blocks.json is missing: it is generated, not committed. ' +
                  'Run: npm run blocks');
    process.exit(1);
  });

const files = await findExampleFlowgraphs(EXAMPLES);
const examples = [];
for (const file of files) {
  const source = await readFile(join(EXAMPLES, file), 'utf8');
  const flowgraph = parseGrc(source);
  const summary = catalog.summarizeExampleFlowgraph(file, flowgraph);
  const slug = catalog.examplePageSlug(file);
  const parts = file.split('/');
  const fragment = catalog.exampleUrl(file, '/').slice(1);   // '#example=<encoded>'
  const blocks = Array.isArray(flowgraph.blocks) ? flowgraph.blocks : [];

  // One row per distinct block id, most-used first: a reader wants to know what
  // the flowgraph is built from, not to read the same name eight times.
  const used = new Map();
  for (const block of blocks) {
    const id = String(block?.id ?? '');
    if (!id) continue;
    used.set(id, (used.get(id) || 0) + 1);
  }
  const rows = [...used].map(([id, count]) => {
    const definition = blockLibrary.get(id);
    return {
      id, count,
      label: definition?.label || id,
      module: definition?.oot_module || (definition ? 'GNU Radio' : ''),
      wiki: definition?.wiki_url || '',
    };
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  examples.push({
    file, slug, source, summary, fragment, rows,
    category: parts.length > 1 ? parts[0] : '',
    url: catalog.examplePageUrl(file),
    // Note blocks are the only prose an author writes *into* a flowgraph, so
    // they are worth surfacing rather than leaving buried in the YAML.
    notes: blocks.filter(block => String(block?.id) === 'note')
      .map(block => String(block?.parameters?.note ?? '').trim()).filter(Boolean),
  });
}

// A collision would silently overwrite one page with another, and hyphenating
// makes it possible (a_b.grc and a-b.grc slug alike). Fail loudly instead.
const seen = new Map();
for (const example of examples) {
  if (seen.has(example.slug))
    throw new Error(`two examples map to /examples/${example.slug}/: ` +
                    `${seen.get(example.slug)} and ${example.file}`);
  seen.set(example.slug, example.file);
}

// ---- leaf pages ------------------------------------------------------------

const byCategory = new Map();
for (const example of examples) {
  if (!byCategory.has(example.category)) byCategory.set(example.category, []);
  byCategory.get(example.category).push(example);
}

const renderLeaf = (example) => {
  const { summary, category } = example;
  const siblings = byCategory.get(category);
  const index = siblings.indexOf(example);
  const label = categoryName(category);
  const trail = [
    { name: 'Examples', url: '/examples/' },
    ...(category ? [{ name: label, url: `/examples/${catalog.exampleSlug(category)}/` }] : []),
    { name: summary.title, self: example.url },
  ];
  const description = metaDescription(summary.description
    || `${summary.title}: a GNU Radio flowgraph with ${summary.blockCount} blocks.`);

  const facts = [
    summary.author ? `<li><b>Author</b> ${esc(summary.author)}</li>` : '',
    category ? `<li><b>Category</b> ${esc(label)}</li>` : '',
    `<li><b>Blocks</b> ${summary.blockCount}</li>`,
    `<li><b>Connections</b> ${summary.connectionCount}</li>`,
    `<li><b>File</b> <code>${esc(example.file)}</code></li>`,
  ].filter(Boolean).join('\n    ');

  const table = `<table>
  <thead><tr><th scope="col">Block</th><th scope="col">Module</th><th scope="col">Used</th></tr></thead>
  <tbody>
${example.rows.map(row => `    <tr><td>` +
    (row.wiki ? `<a href="${esc(row.wiki)}" rel="nofollow">${esc(row.label)}</a>` : esc(row.label)) +
    `</td><td class="module"><code>${esc(row.module)}</code></td>` +
    `<td class="count">${row.count}</td></tr>`).join('\n')}
  </tbody>
</table>`;

  const notes = example.notes.length ? `<h2>Notes in this flowgraph</h2>
<ul class="notes">
${example.notes.map(note => `  <li>${esc(note)}</li>`).join('\n')}
</ul>` : '';

  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const siblingNav = `<nav class="siblings">
  ${previous ? `<a href="${esc(previous.url)}">← ${esc(previous.summary.title)}</a>` : ''}
  <a href="${category ? `/examples/${catalog.exampleSlug(category)}/` : '/examples/'}">All ${esc(label)} examples</a>
  ${next ? `<a href="${esc(next.url)}">${esc(next.summary.title)} →</a>` : ''}
</nav>`;

  const softwareLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    name: summary.title,
    description: summary.description || undefined,
    url: ORIGIN + example.url,
    codeRepository: REPO,
    programmingLanguage: 'GNU Radio Companion flowgraph',
    runtimePlatform: 'GNU Radio World (WebAssembly, in the browser)',
    license: 'https://www.gnu.org/licenses/gpl-3.0.html',
    author: summary.author ? { '@type': 'Person', name: summary.author } : undefined,
    isPartOf: { '@type': 'WebApplication', name: 'GNU Radio World', url: ORIGIN + '/' },
  };

  return page({
    title: `${summary.title} — GNU Radio World example flowgraph`,
    description,
    canonical: ORIGIN + example.url,
    jsonLd: [breadcrumbLd(trail), JSON.parse(JSON.stringify(softwareLd))],
    body: `${crumbs(trail)}
<h1>${esc(summary.title)}</h1>
${summary.description ? `<p class="lede">${esc(summary.description)}</p>` : ''}
<ul class="facts">
    ${facts}
</ul>

<div class="embed">
  <iframe src="${esc('/?embed=1&click_to_load=1&zoom=fit' + example.fragment)}"
          title="${esc(summary.title)} flowgraph, running in GNU Radio World"
          loading="lazy" allow="usb; microphone"></iframe>
</div>
<p class="embed-note">Press <b>Load</b> to open this flowgraph in an editor embedded
   above, then ▶ to run it. Nothing is downloaded until you do.</p>

<div class="actions">
  <a class="primary" href="${esc('/' + example.fragment)}">Open in the full editor ▶</a>
  <a href="${esc('/example_flowgraphs/' + catalog.encodeExamplePath(example.file))}"
     download>Download the .grc</a>
</div>

<h2>Blocks used</h2>
${table}

${notes}

<h2>Flowgraph source</h2>
<details>
  <summary>${esc(example.file)}</summary>
  <pre>${esc(example.source)}</pre>
</details>

${siblingNav}`,
  });
};

// ---- category and hub pages ------------------------------------------------

// A card's blurb, not the whole description: several examples carry a
// maintainer's note after the first sentence ("...the 1/(2*pi) constant is
// pre-computed because...") that is worth keeping on the example's own page and
// makes a mess of a grid of cards. First sentence, and clamped even then.
const blurbOf = (example) => {
  const text = (example.summary.description || '').replace(/\s+/g, ' ').trim();
  if (!text) return `${example.summary.blockCount} blocks`;
  const sentence = text.split(/(?<=\.)\s+(?=[A-Z])/)[0];
  if (sentence.length <= 150) return sentence;
  const clamped = sentence.slice(0, 130);
  return clamped.slice(0, clamped.lastIndexOf(' ')).trimEnd() + '…';
};

const renderCategory = (category, entries) => {
  const label = categoryName(category);
  const url = `/examples/${catalog.exampleSlug(category)}/`;
  const trail = [{ name: 'Examples', url: '/examples/' }, { name: label, self: url }];
  return page({
    title: `${label} example flowgraphs — GNU Radio World`,
    description: `${entries.length} GNU Radio ${label} example flowgraph` +
      `${entries.length === 1 ? '' : 's'} you can open and run in your browser — no install.`,
    canonical: ORIGIN + url,
    jsonLd: [breadcrumbLd(trail)],
    body: `${crumbs(trail)}
<h1>${esc(label)} example flowgraphs</h1>
<p class="lede">${entries.length} example${entries.length === 1 ? '' : 's'} you can open
   and run in the browser, with no GNU Radio installation.</p>
${cards(entries.map(example => ({
  url: example.url, title: example.summary.title, blurb: blurbOf(example),
})))}`,
  });
};

const renderHub = () => {
  const trail = [{ name: 'Examples', self: '/examples/' }];
  const categories = [...byCategory.keys()].sort((a, b) =>
    categoryName(a).localeCompare(categoryName(b)));
  return page({
    title: 'GNU Radio example flowgraphs you can run in your browser',
    description: `Browse ${examples.length} GNU Radio example flowgraphs — analog, ` +
      'digital, filters, satellites, RDS, LoRa, OFDM and more. Open and run any of ' +
      'them in your browser, with no install.',
    canonical: ORIGIN + '/examples/',
    jsonLd: [breadcrumbLd(trail), {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'GNU Radio example flowgraphs',
      url: ORIGIN + '/examples/',
      isPartOf: { '@type': 'WebApplication', name: 'GNU Radio World', url: ORIGIN + '/' },
      numberOfItems: examples.length,
    }],
    body: `${crumbs(trail)}
<h1>GNU Radio example flowgraphs</h1>
<p class="lede">${examples.length} flowgraphs covering analog and digital modulation,
   filtering, satellite and weather-image decoding, RDS, LoRa, OFDM, Wi-Fi and more.
   Every one opens and runs in the browser — no GNU Radio installation, no Python.</p>
<div class="actions"><a class="primary" href="/">Open the editor ▶</a></div>
${categories.map(category => {
  const entries = byCategory.get(category);
  const label = categoryName(category);
  const url = category ? `/examples/${catalog.exampleSlug(category)}/` : '/examples/';
  return `
<h2>${category ? `<a href="${esc(url)}">${esc(label)}</a>` : 'Uncategorised'}</h2>
${cards(entries.map(example => ({
  url: example.url, title: example.summary.title, blurb: blurbOf(example),
})))}`;
}).join('\n')}`,
  });
};

// ---- write -----------------------------------------------------------------

const write = async (path, html) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html);
};

// Wipe first: an example that has been renamed or deleted must not leave a page
// behind, still listed in the sitemap and still answering 200.
await rm(OUT, { recursive: true, force: true });
await write(join(OUT, 'index.html'), renderHub());
for (const [category, entries] of byCategory) {
  if (!category) continue;
  await write(join(OUT, catalog.exampleSlug(category), 'index.html'),
              renderCategory(category, entries));
}
for (const example of examples)
  await write(join(OUT, ...example.slug.split('/'), 'index.html'), renderLeaf(example));

// The sitemap is generated here rather than kept by hand because this is where
// the full set of URLs is known.
const urls = [
  { loc: '/', changefreq: 'weekly', priority: '1.0' },
  { loc: '/examples/', changefreq: 'weekly', priority: '0.9' },
  ...[...byCategory.keys()].filter(Boolean).sort()
    .map(category => ({ loc: `/examples/${catalog.exampleSlug(category)}/`,
                        changefreq: 'monthly', priority: '0.7' })),
  ...examples.map(example => ({ loc: example.url, changefreq: 'monthly', priority: '0.6' })),
  { loc: '/privacy.html', changefreq: 'yearly', priority: '0.2' },
  { loc: '/terms.html', changefreq: 'yearly', priority: '0.2' },
];
await writeFile(join(PUBLIC, 'sitemap.xml'),
`<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by editor/gen/gen_example_pages.mjs. The editor's own example
     links are URL fragments, which a crawler cannot tell apart from the bare
     editor, so the pages listed here are the site's only indexable route to
     its example flowgraphs. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url>
    <loc>${ORIGIN}${url.loc}</loc>
    <changefreq>${url.changefreq}</changefreq>
    <priority>${url.priority}</priority>
  </url>`).join('\n')}
</urlset>
`);

console.log(`examples: ${examples.length} pages in ${byCategory.size} categories, ` +
            `sitemap: ${urls.length} URLs`);
