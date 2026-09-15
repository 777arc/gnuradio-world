import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { repositoryAgeLabel } from '../gen/gen_cgran_pages.mjs';
import { exampleFiles } from './example-files.mjs';
import { bundleModule } from './bundle-module.mjs';
import { pathNeedsIsolation } from '../../scripts/http-support.mjs';

const root = new URL('../../', import.meta.url);
const readJson = path => readFile(new URL(path, root), 'utf8').then(JSON.parse);
const projects = await readJson('editor/content/cgran-projects.json');
const snapshot = await readJson('editor/content/cgran-repository-snapshot.json');
const blockLibrary = await readJson('editor/public/blocks.json');
const { parseGrc } = await bundleModule('../src/grc.ts');
const exampleCatalog = await bundleModule('../src/example-catalog.ts');

const supported = [...new Set(blockLibrary.blocks
  .filter(block => block.runnable === true && block.oot_module)
  .map(block => block.oot_module))].sort();
const catalogued = projects.projects.map(project => project.module).sort();
assert.deepEqual(catalogued, supported, 'catalog membership must follow runnable OOT metadata');
assert.equal(new Set(projects.projects.map(project => project.slug)).size, projects.projects.length);
for (const project of projects.projects) {
  assert.ok(project.summary.length >= 3 && project.summary.length <= 4, `${project.module}: summary length`);
  assert.ok(project.authors.length >= 1 && project.authors.length <= 2, `${project.module}: author count`);
  assert.ok(project.evidence.length && project.evidence.every(path => !/manifest\.ya?ml|manifest\.md/i.test(path)),
    `${project.module}: source evidence`);
  assert.equal(snapshot.repositories[project.module].repository, project.repository);
  if (project.artwork) {
    assert.match(project.artwork.source_url, /^https:\/\//);
    assert.ok(project.artwork.alt && project.artwork.label);
    assert.ok(['cover', 'contain'].includes(project.artwork.fit));
    assert.notEqual(Boolean(project.artwork.source_path), Boolean(project.artwork.remote_url));
  }
}
assert.equal(projects.projects.filter(project => project.artwork).length, 10,
  'the audited project-artwork set changed unexpectedly');
assert.deepEqual(projects.artwork_audit.no_suitable_artwork.slice().sort(),
  projects.projects.filter(project => !project.artwork).map(project => project.module).sort(),
  'every text-only project must be recorded as audited');

assert.equal(repositoryAgeLabel('2026-07-01T00:00:00Z', '2026-09-14T00:00:00Z'), '< 3 months');
assert.equal(repositoryAgeLabel('2026-06-16T00:00:00Z', '2026-09-14T00:00:00Z'), '2026-06-16');
assert.throws(() => repositoryAgeLabel('not-a-date', '2026-09-14T00:00:00Z'));
assert.equal(pathNeedsIsolation('/cgran'), false);
assert.equal(pathNeedsIsolation('/cgran/'), false);
assert.equal(pathNeedsIsolation('/cgran/gr-fosphor/'), false);
assert.equal(pathNeedsIsolation('/'), true);
assert.equal(pathNeedsIsolation('/runner/build/runner.html'), true);

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [new URL('../gen/gen_example_pages.mjs', import.meta.url).pathname],
    { stdio: 'ignore' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`page generator exited ${code}`)));
});
const generated = relative => readFile(new URL('../public/' + relative, import.meta.url), 'utf8');
const hub = await generated('cgran/index.html');
assert.match(hub, /<link rel="canonical" href="https:\/\/gnuradioworld\.com\/cgran\/" \/>/);
assert.match(hub, /data-cgran-search/);
assert.match(hub, /mailto:support@gnuradioworld\.com/);
assert.match(hub, /https:\/\/discord\.gg\/qKK2kC6Fpw/);
const definitionById = new Map(blockLibrary.blocks.map(block => [block.id, block]));
const expectedExamples = new Map(projects.projects.map(project => [project.module, []]));
for (const file of exampleFiles) {
  const source = await readFile(new URL('../../example_flowgraphs/' + file, import.meta.url), 'utf8');
  const flowgraph = parseGrc(source);
  const modules = new Set((flowgraph.blocks || [])
    .map(block => definitionById.get(String(block.id))?.oot_module).filter(Boolean));
  for (const module of modules) expectedExamples.get(module)?.push(file);
}
for (const project of projects.projects) {
  assert.ok(hub.includes(`href="/cgran/${project.slug}/"`), `hub omits ${project.module}`);
  const leaf = await generated(`cgran/${project.slug}/index.html`);
  assert.ok(leaf.includes(`<h1>${project.name}</h1>`), `${project.module}: missing heading`);
  assert.ok(leaf.includes(project.repository), `${project.module}: missing repository`);
  assert.doesNotMatch(leaf, /Supported[- ]block count|Blocks supported|GNU Radio Packaging Legend/i);
  for (const file of expectedExamples.get(project.module)) {
    const url = exampleCatalog.examplePageUrl(file);
    assert.ok(leaf.includes(`href="${url}"`), `${project.module}: missing ${file}`);
  }
  const emittedExampleLinks = (leaf.match(/href="\/examples\/[^\"]+\/"/g) || []).length;
  assert.equal(emittedExampleLinks, expectedExamples.get(project.module).length,
    `${project.module}: emitted an example that does not use the OOT`);
  if (project.artwork) {
    const expectedArtworkUrl = project.artwork.remote_url ||
      `/cgran/art/${project.slug}${project.artwork.source_path.match(/\.[^.]+$/)[0].toLowerCase()}`;
    assert.ok(hub.includes(`src="${expectedArtworkUrl}"`), `${project.module}: hub artwork missing`);
    assert.ok(leaf.includes(`src="${expectedArtworkUrl}"`), `${project.module}: project artwork missing`);
    assert.ok(leaf.includes(project.artwork.source_url), `${project.module}: artwork provenance missing`);
    if (project.artwork.source_path)
      await stat(new URL(`../public/cgran/art/${project.slug}${project.artwork.source_path.match(/\.[^.]+$/)[0].toLowerCase()}`, import.meta.url));
  }
}
assert.doesNotMatch(hub, /Supported[- ]block count|Blocks supported|GNU Radio Packaging Legend/i);

const satellites = await generated('cgran/gr-satellites/index.html');
assert.ok(satellites.includes('/examples/gr-droneid/droneid-mavic3/'));
const droneid = await generated('cgran/gr-droneid/index.html');
assert.ok(droneid.includes('/examples/gr-droneid/droneid-mavic3/'));
const dvbs2rx = await generated('cgran/gr-dvbs2rx/index.html');
assert.ok(dvbs2rx.includes('/examples/gr-dvbs2/dvbs2-loopback/'));
const fosphor = await generated('cgran/gr-fosphor/index.html');
assert.ok(fosphor.includes('/examples/digital/welcome-example/'));
for (const slug of ['gr-foo', 'gr-gsm'])
  assert.match(await generated(`cgran/${slug}/index.html`), /There are no GNU Radio World example flowgraphs/);

// Recent repository activity stays coarse everywhere, including JSON-LD.
assert.ok(hub.includes('&lt; 3 months'));
assert.ok(!hub.includes('2026-09-11'));
assert.ok(!satellites.includes('2026-09-11'));

const sitemap = await generated('sitemap.xml');
assert.ok(sitemap.includes('<loc>https://gnuradioworld.com/cgran/</loc>'));
for (const project of projects.projects)
  assert.ok(sitemap.includes(`<loc>https://gnuradioworld.com/cgran/${project.slug}/</loc>`));

console.log(`cgran-pages: ok (${projects.projects.length} supported OOTs)`);
