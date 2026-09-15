import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';

const ORIGIN = 'https://gnuradioworld.com';
const WORLD_REPO = 'https://github.com/777arc/gnuradio-world';
const DISCORD = 'https://discord.gg/qKK2kC6Fpw';
const EMAIL = 'support@gnuradioworld.com';
const GA_MEASUREMENT_ID = 'G-NJ22205C3S';
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const page = ({ title, description, canonical, jsonLd = [], body, script = '', mainClass = '' }) => `<!doctype html>
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
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon.ico" sizes="32x32" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA_MEASUREMENT_ID}');
</script>
<link rel="stylesheet" href="/examples.css" />
<link rel="stylesheet" href="/cgran.css" />
${jsonLd.map(data => `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`).join('\n')}
${script}
</head>
<body>
<header><a href="/" aria-label="GNU Radio World home"><img src="/gnuradio_world_logo_dark.svg" alt="GNU Radio World" /></a></header>
<main${mainClass ? ` class="${esc(mainClass)}"` : ''}>${body}</main>
<footer><a href="/">Open the editor</a><a href="/examples/">All examples</a><a href="/cgran/">Supported OOTs</a><a href="${DISCORD}">Discord</a><a href="${WORLD_REPO}">GitHub</a><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a></footer>
</body>
</html>
`;

const crumbs = (trail) => `<nav class="crumbs" aria-label="Breadcrumb">` +
  trail.map((step, index) => (index ? '<span aria-hidden="true">/</span>' : '') +
    (step.url ? `<a href="${esc(step.url)}">${esc(step.name)}</a>` : `<b>${esc(step.name)}</b>`)).join('') +
  `</nav>`;

const breadcrumbLd = (trail) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: trail.map((step, index) => ({
    '@type': 'ListItem', position: index + 1, name: step.name,
    item: ORIGIN + (step.url || step.self),
  })),
});

export const repositoryAgeLabel = (latestCommitAt, checkedAt) => {
  const commit = Date.parse(latestCommitAt);
  const checked = Date.parse(checkedAt);
  if (!Number.isFinite(commit) || !Number.isFinite(checked) || commit > checked + 24 * 60 * 60 * 1000)
    throw new Error(`invalid repository dates: ${latestCommitAt}, ${checkedAt}`);
  return checked - commit < THREE_MONTHS_MS
    ? '< 3 months'
    : new Date(commit).toISOString().slice(0, 10);
};

const authorsHtml = (authors) => authors.map(author => author.url
  ? `<a href="${esc(author.url)}">${esc(author.name)}</a>`
  : esc(author.name)).join(', ');

const summaryHtml = (summary) => summary.map(sentence => esc(sentence)).join(' ');

const validate = ({ projects, snapshot, blockDefinitions }) => {
  if (projects.schema !== 1 || snapshot.schema !== 1) throw new Error('unsupported CGRAN content schema');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(projects.artwork_audit?.checked_at || '') ||
      !Array.isArray(projects.artwork_audit?.no_suitable_artwork))
    throw new Error('CGRAN content needs a dated artwork audit');
  const modules = new Set();
  const slugs = new Set();
  for (const project of projects.projects) {
    if (!project.module || modules.has(project.module)) throw new Error(`duplicate or empty CGRAN module: ${project.module}`);
    if (!project.slug || slugs.has(project.slug)) throw new Error(`duplicate or empty CGRAN slug: ${project.slug}`);
    modules.add(project.module); slugs.add(project.slug);
    if (!Array.isArray(project.summary) || project.summary.length < 3 || project.summary.length > 4 || project.summary.some(value => !String(value).trim()))
      throw new Error(`${project.module}: summary must contain 3–4 non-empty sentences`);
    if (!Array.isArray(project.authors) || project.authors.length < 1 || project.authors.length > 2)
      throw new Error(`${project.module}: choose one or two main authors`);
    if (!/^https:\/\//.test(project.repository)) throw new Error(`${project.module}: invalid repository URL`);
    if (!Array.isArray(project.evidence) || !project.evidence.length || project.evidence.some(path => /manifest\.ya?ml|manifest\.md/i.test(path)))
      throw new Error(`${project.module}: evidence must name source files other than MANIFEST.yml/MANIFEST.md`);
    if (project.artwork) {
      const artwork = project.artwork;
      if (Boolean(artwork.source_path) === Boolean(artwork.remote_url))
        throw new Error(`${project.module}: artwork needs exactly one source_path or remote_url`);
      if (artwork.source_path &&
          (!/^(?:gr-[^/]+\/|editor\/content\/cgran-artwork\/)[^/].*/.test(artwork.source_path) || artwork.source_path.includes('..')))
        throw new Error(`${project.module}: artwork source_path must stay inside an OOT checkout or the CGRAN artwork snapshot directory`);
      if (artwork.remote_url && !/^https:\/\//.test(artwork.remote_url))
        throw new Error(`${project.module}: artwork remote_url must use HTTPS`);
      if (!/^https:\/\//.test(artwork.source_url) || !artwork.alt || !artwork.label ||
          !['cover', 'contain'].includes(artwork.fit))
        throw new Error(`${project.module}: artwork needs an HTTPS source, alt text, label, and fit`);
    }
    const entry = snapshot.repositories?.[project.module];
    if (!entry || entry.repository !== project.repository) throw new Error(`${project.module}: missing or mismatched repository snapshot`);
    if (Date.now() - Date.parse(entry.checked_at) >= THREE_MONTHS_MS)
      throw new Error(`${project.module}: repository snapshot is 3 months old; run node scripts/refresh-cgran-metadata.mjs`);
    repositoryAgeLabel(entry.latest_commit_at, entry.checked_at);
  }

  const supported = new Set(blockDefinitions
    .filter(block => block.runnable === true && block.oot_module)
    .map(block => block.oot_module));
  const missing = [...supported].filter(module => !modules.has(module));
  const extra = [...modules].filter(module => !supported.has(module));
  if (missing.length || extra.length)
    throw new Error(`CGRAN content does not match runnable OOT metadata; missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`);
  const snapshotExtra = Object.keys(snapshot.repositories || {}).filter(module => !modules.has(module));
  if (snapshotExtra.length) throw new Error(`repository snapshot has unknown modules: ${snapshotExtra.join(', ')}`);
  const withoutArtwork = projects.projects.filter(project => !project.artwork).map(project => project.module).sort();
  const auditedWithoutArtwork = [...projects.artwork_audit.no_suitable_artwork].sort();
  if (new Set(auditedWithoutArtwork).size !== auditedWithoutArtwork.length ||
      withoutArtwork.join('\0') !== auditedWithoutArtwork.join('\0'))
    throw new Error('artwork audit must name every and only project without suitable artwork');
};

const exampleCards = (examples) => examples.length
  ? `<ul class="cards">\n${examples.map(example =>
      `  <li><a href="${esc(example.url)}"><strong>${esc(example.summary.title)}</strong>` +
      `<span>${esc(example.summary.description || 'Open this flowgraph in GNU Radio World.')}</span></a></li>`).join('\n')}\n</ul>`
  : `<p class="empty-state">There are no GNU Radio World example flowgraphs using this OOT yet.</p>`;

const artworkClass = (project) => `oot-art oot-art--${project.artwork.fit}` +
  (project.artwork.light_background ? ' oot-art--light' : '');

const cardArtwork = (project) => project.artwork ?
  `<a class="${artworkClass(project)}" href="/cgran/${esc(project.slug)}/" tabindex="-1" aria-hidden="true"><img src="${esc(project.artworkUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></a>` : '';

const projectArtwork = (project) => project.artwork ?
  `<figure class="project-art ${artworkClass(project)}"><img src="${esc(project.artworkUrl)}" alt="${esc(project.artwork.alt)}" decoding="async" referrerpolicy="no-referrer" /><figcaption><a href="${esc(project.artwork.source_url)}">${esc(project.artwork.label)}</a></figcaption></figure>` : '';

const projectLd = (project, snapshotEntry, url, ageLabel) => ({
  '@context': 'https://schema.org',
  '@type': 'SoftwareSourceCode',
  name: project.name,
  description: project.summary.join(' '),
  url: ORIGIN + url,
  codeRepository: project.repository,
  author: project.authors.map(author => ({ '@type': 'Person', name: author.name, url: author.url })),
  isPartOf: { '@type': 'CollectionPage', name: 'GNU Radio World supported OOTs', url: ORIGIN + '/cgran/' },
  // Never leak the exact recent date through structured data: the visible and
  // machine-readable pages make the same coarse promise.
  ...(ageLabel === '< 3 months' ? {} : { dateModified: snapshotEntry.latest_commit_at }),
});

export async function generateCgranPages({ root, publicDir, examples, blockDefinitions }) {
  const projects = JSON.parse(await readFile(join(root, 'editor/content/cgran-projects.json'), 'utf8'));
  const snapshot = JSON.parse(await readFile(join(root, 'editor/content/cgran-repository-snapshot.json'), 'utf8'));
  validate({ projects, snapshot, blockDefinitions });

  const out = join(publicDir, 'cgran');
  await rm(out, { recursive: true, force: true });
  const withDetails = projects.projects.map(project => {
    const repository = snapshot.repositories[project.module];
    const ageLabel = repositoryAgeLabel(repository.latest_commit_at, repository.checked_at);
    const relatedExamples = examples.filter(example => example.rows.some(row => row.module === project.module));
    return { ...project, repositorySnapshot: repository, ageLabel, relatedExamples };
  }).sort((a, b) => Date.parse(b.repositorySnapshot.latest_commit_at) - Date.parse(a.repositorySnapshot.latest_commit_at)
                   || a.name.localeCompare(b.name));

  // Repository-owned images travel with the generated catalog, without
  // committing duplicate binary files. A few official project-site images are
  // intentionally referenced at their origin and retain a source link beside
  // the full-size project artwork.
  for (const project of withDetails) {
    if (!project.artwork) continue;
    if (project.artwork.remote_url) {
      project.artworkUrl = project.artwork.remote_url;
      continue;
    }
    const extension = extname(project.artwork.source_path).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.svg', '.webp'].includes(extension))
      throw new Error(`${project.module}: unsupported artwork extension ${extension}`);
    const relative = `art/${project.slug}${extension}`;
    const destination = join(out, relative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, project.artwork.source_path), destination);
    project.artworkUrl = `/cgran/${relative}`;
  }

  const write = async (path, html) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, html);
  };

  const hubTrail = [{ name: 'Supported OOTs', self: '/cgran/' }];
  const cards = withDetails.map(project => {
    const searchable = [project.name, ...project.summary, ...project.authors.map(author => author.name)].join(' ').toLocaleLowerCase();
    return `<li class="oot-card" data-cgran-card data-search="${esc(searchable)}">
  ${cardArtwork(project)}
  <a class="oot-card-link" href="/cgran/${esc(project.slug)}/"><h2>${esc(project.name)}</h2></a>
  <p>${summaryHtml(project.summary)}</p>
  <dl><div><dt>Main author${project.authors.length === 1 ? '' : 's'}</dt><dd>${authorsHtml(project.authors)}</dd></div><div><dt>Last modified</dt><dd>${esc(project.ageLabel)}</dd></div></dl>
</li>`;
  }).join('\n');
  await write(join(out, 'index.html'), page({
    title: 'Supported GNU Radio out-of-tree modules — GNU Radio World',
    description: 'Browse the GNU Radio out-of-tree modules available in GNU Radio World, with concise project summaries, authors, repository activity, and runnable examples.',
    canonical: ORIGIN + '/cgran/',
    jsonLd: [breadcrumbLd(hubTrail), {
      '@context': 'https://schema.org', '@type': 'CollectionPage',
      name: 'GNU Radio World supported OOTs', url: ORIGIN + '/cgran/',
      isPartOf: { '@type': 'WebApplication', name: 'GNU Radio World', url: ORIGIN + '/' },
    }],
    script: '<script src="/cgran.js" defer></script>',
    mainClass: 'catalog-hub',
    body: `<h1>Supported out-of-tree modules</h1>
<p class="lede">A CGRAN-like directory of the GNU Radio out-of-tree modules you can use in GNU Radio World. Each entry is researched from the project repository and links to every matching flowgraph in our example library.</p>
<label class="catalog-search">Search projects<input type="search" placeholder="Name, purpose, or author" autocomplete="off" data-cgran-search /></label>
<p class="search-status" data-cgran-status aria-live="polite"></p>
<ul class="oot-grid" data-cgran-list>${cards}</ul>
<section class="submit-oot" id="add-your-oot"><h2>Get your OOT added</h2><p>To get your OOT added to GNU Radio World (e.g. usable blocks and example flowgraphs) and included on this list, <a href="mailto:${EMAIL}?subject=Add%20my%20OOT%20to%20GNU%20Radio%20World">email Marc</a> or hop on the <a href="${DISCORD}">GNU Radio World Discord</a>.</p></section>`,
  }));

  for (const project of withDetails) {
    const url = `/cgran/${project.slug}/`;
    const trail = [{ name: 'Supported OOTs', url: '/cgran/' }, { name: project.name, self: url }];
    const sourceLink = project.world_source_repository && project.world_source_repository !== project.repository
      ? `<a href="${esc(project.world_source_repository)}">GNU Radio World source snapshot</a>` : '';
    await write(join(out, project.slug, 'index.html'), page({
      title: `${project.name} — GNU Radio World supported OOT`,
      description: project.summary.join(' '),
      canonical: ORIGIN + url,
      jsonLd: [breadcrumbLd(trail), projectLd(project, project.repositorySnapshot, url, project.ageLabel)],
      body: `${crumbs(trail)}
<div class="project-heading"><div><h1>${esc(project.name)}</h1>
<p class="project-kind">Out-of-tree GNU Radio module available in GNU Radio World</p></div>
${projectArtwork(project)}</div>
<p class="project-summary">${summaryHtml(project.summary)}</p>
<dl class="project-facts">
  <div><dt>Main author${project.authors.length === 1 ? '' : 's'}</dt><dd>${authorsHtml(project.authors)}</dd></div>
  <div><dt>Last modified</dt><dd>${esc(project.ageLabel)}</dd></div>
  <div><dt>Project</dt><dd><a href="${esc(project.repository)}">Upstream repository</a>${sourceLink ? ` · ${sourceLink}` : ''}</dd></div>
</dl>
<h2>Example flowgraphs</h2>
<p>These GNU Radio World examples contain one or more blocks from ${esc(project.name)}.</p>
${exampleCards(project.relatedExamples)}`,
    }));
  }

  return [
    { loc: '/cgran/', changefreq: 'monthly', priority: '0.8' },
    ...withDetails.map(project => ({ loc: `/cgran/${project.slug}/`, changefreq: 'monthly', priority: '0.7' })),
  ];
}
