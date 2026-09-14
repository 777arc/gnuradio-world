#!/usr/bin/env node
// Refresh the small, committed repository snapshot used by /cgran/. This reads
// Git history only. Descriptions and author choices are deliberately maintained
// in editor/content/cgran-projects.json after a human/agent reviews the source.
//
// Usage:
//   node scripts/refresh-cgran-metadata.mjs          # every project
//   node scripts/refresh-cgran-metadata.mjs gr-rds   # selected projects
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = new URL('../', import.meta.url).pathname;
const PROJECTS_FILE = join(ROOT, 'editor/content/cgran-projects.json');
const SNAPSHOT_FILE = join(ROOT, 'editor/content/cgran-repository-snapshot.json');

const projectsDocument = JSON.parse(await readFile(PROJECTS_FILE, 'utf8'));
const requested = new Set(process.argv.slice(2));
const known = new Set(projectsDocument.projects.map(project => project.module));
for (const module of requested) {
  if (!known.has(module)) throw new Error(`unknown CGRAN module: ${module}`);
}
const projects = requested.size
  ? projectsDocument.projects.filter(project => requested.has(project.module))
  : projectsDocument.projects;

let previous = { schema: 1, repositories: {} };
try { previous = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')); } catch {}
const repositories = { ...(previous.repositories || {}) };
const scratch = await mkdtemp(join(tmpdir(), 'grworld-cgran-'));

try {
  for (const project of projects) {
    const destination = join(scratch, project.module);
    process.stdout.write(`${project.module}: fetching all branch heads... `);
    await exec('git', [
      'clone', '--bare', '--filter=blob:none', '--no-tags', '--quiet',
      project.repository, destination,
    ], { maxBuffer: 16 * 1024 * 1024 });

    // A bare clone maps every advertised remote branch into refs/heads. Git's
    // default log ordering starts with the newest committer date, so this is
    // the newest commit reachable from any branch, without allowing a newer
    // tag-only commit to affect the result.
    const { stdout } = await exec('git', [
      '--git-dir', destination, 'log', '--branches', '-1',
      '--format=%H%n%cI',
    ]);
    const [latestCommit, latestCommitAt] = stdout.trim().split('\n');
    if (!/^[0-9a-f]{40}$/i.test(latestCommit) || !latestCommitAt)
      throw new Error(`${project.module}: could not identify its latest branch commit`);

    repositories[project.module] = {
      repository: project.repository,
      checked_at: new Date().toISOString(),
      latest_commit: latestCommit,
      latest_commit_at: latestCommitAt,
    };
    process.stdout.write(`${latestCommit.slice(0, 10)} ${latestCommitAt}\n`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const ordered = {};
for (const project of projectsDocument.projects) {
  if (repositories[project.module]) ordered[project.module] = repositories[project.module];
}
await writeFile(SNAPSHOT_FILE, JSON.stringify({ schema: 1, repositories: ordered }, null, 2) + '\n');
console.log(`wrote ${SNAPSHOT_FILE}`);
