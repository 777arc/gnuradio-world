// Collect every version that makes up the GNU Radio World stack, at build time.
//
// Nothing here is hand-maintained: each number is read back out of the file that
// pins it, so the Help ▸ Software Versions dialog can never drift from what was
// actually built. The pins live in exactly one place each --
// `deps/fetch-deps.sh` for the C++ dependencies, `deps/env.sh` for Emscripten,
// `.github/workflows/build.yml` for Qt, `deps/fetch-pyodide.sh` for the Python
// runtime, the submodule gitlinks for GNU Radio and the OOTs, and
// `editor/package-lock.json` for the web dependencies.
//
// Used two ways:
//   - imported by editor/vite.config.ts, which serves the result as the
//     `virtual:versions` module, so a dev server and a production build both get
//     the versions of the tree they are running out of;
//   - `node editor/gen/gen_versions.mjs` prints the JSON, for eyeballing it.
//
// Everything is best-effort: a missing submodule checkout, a tree with no git
// history, or a dependency file that has been reworded degrades to "unknown"
// rather than failing the build.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(...parts) {
  try { return readFileSync(join(REPO_ROOT, ...parts), 'utf8'); } catch { return ''; }
}
function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
/** First capture group of `re` in `text`, or '' when it does not match. */
function match1(text, re) {
  const m = text.match(re);
  return m ? m[1] : '';
}
/** A git tag as a version: v1.12.0 and release-1.2.2.0 both mean the number. */
function tagVersion(tag) {
  return tag.replace(/^v(?=\d)/, '').replace(/^release-/, '');
}

// ---------------------------------------------------------------- this repo --

function appInfo() {
  const commit = git(REPO_ROOT, ['rev-parse', '--short', 'HEAD']);
  return {
    commit: commit || 'unknown',
    commitDate: git(REPO_ROOT, ['log', '-1', '--format=%cs']) || 'unknown',
    branch: git(REPO_ROOT, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
    // A build off a tree with uncommitted edits is worth saying out loud: the
    // commit above then does not describe what is running.
    dirty: git(REPO_ROOT, ['status', '--porcelain']) !== '',
    buildDate: new Date().toISOString().slice(0, 10),
  };
}

// -------------------------------------------------------- GNU Radio and OOTs --

/** GNU Radio's own version, as its CMakeLists spells it: MAJOR.API.ABI.PATCH. */
function gnuradioVersion() {
  const cm = read('gnuradio', 'CMakeLists.txt');
  const parts = ['MAJOR', 'API', 'ABI', 'PATCH']
    .map(k => match1(cm, new RegExp(`SET\\(VERSION_${k}\\s+([^)\\s]+)`, 'i')));
  return parts.every(Boolean) ? parts.join('.') : 'unknown';
}

/** path -> url, in .gitmodules order (GNU Radio first, then the OOTs). */
function submodules() {
  const text = read('.gitmodules');
  const mods = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const name = match1(line, /^\s*\[submodule\s+"([^"]+)"\]/);
    if (name) { cur = { name }; mods.push(cur); continue; }
    if (!cur) continue;
    const path = match1(line, /^\s*path\s*=\s*(.+?)\s*$/);
    if (path) cur.path = path;
    const url = match1(line, /^\s*url\s*=\s*(.+?)\s*$/);
    if (url) cur.url = url.replace(/\.git$/, '');
  }
  return mods.filter(m => m.path);
}

/**
 * One row per submodule. `describe` is the useful column when the checkout has
 * tags (gr-satellites reports v4-git-640-gb8b227d4); CI clones them shallow and
 * untagged, so the commit is what always survives.
 */
function submoduleRow(mod) {
  const dir = join(REPO_ROOT, mod.path);
  const present = existsSync(join(dir, '.git')) || existsSync(dir);
  // The gitlink in the superproject is authoritative even when the submodule
  // itself was never checked out.
  const gitlink = match1(git(REPO_ROOT, ['ls-tree', 'HEAD', mod.path]), /^\S+\s+commit\s+(\S+)/);
  const head = present ? git(dir, ['rev-parse', 'HEAD']) : '';
  const commit = (head || gitlink).slice(0, 12);
  const described = present ? tagVersion(git(dir, ['describe', '--tags', '--always'])) : '';
  const date = present ? git(dir, ['log', '-1', '--format=%cs']) : '';
  return {
    name: mod.path,
    // Only a describe that resolves to a *version* tag says anything. A branch
    // name the tag happens to carry (gr-foo) does not, and neither does the bare
    // sha --always falls back to -- which can itself start with a digit.
    version: /^\d/.test(described) && !/^[0-9a-f]{7,40}$/.test(described) ? described : '—',
    detail: [commit ? `commit ${commit}` : 'not checked out', date].filter(Boolean).join(' · '),
    url: mod.url,
  };
}

// ------------------------------------------------------- C++ dependency pins --

const DEP_NAMES = {
  volk: 'VOLK', spdlog: 'spdlog', boost: 'Boost', fftw: 'FFTW', gmp: 'GMP',
  qwt: 'Qwt', crcpp: 'CRCpp', turbofec: 'turbofec',
};
/** "boost_1_83_0" / "fftw-3.3.10" -> ["Boost", "1.83.0"]. */
function splitDirVersion(dir) {
  const m = dir.match(/^(.*?)[-_](\d[\d._]*)$/);
  const base = (m ? m[1] : dir).toLowerCase();
  return [DEP_NAMES[base] || base, m ? m[2].replace(/_/g, '.') : ''];
}

/**
 * The dependencies build-deps.sh compiles, in the order fetch-deps.sh pins them.
 * Three fetch forms live in that file -- a tagged clone, a clone of one commit
 * for a dependency that publishes no tag, and a release tarball -- and the
 * version is in a different argument in each.
 */
function cppDeps() {
  const sh = read('deps', 'fetch-deps.sh');
  const rows = [];
  // clone_commit spans two lines (the pinned sha is long); join continuations.
  const lines = sh.replace(/\\\n\s*/g, ' ').split('\n');
  for (const line of lines) {
    let m;
    if ((m = line.match(/^clone\s+(\S+)\s+(\S+)\s+(\S+)/))) {
      const [name] = splitDirVersion(m[1]);
      rows.push({ name, version: tagVersion(m[2]), detail: '', url: m[3].replace(/\.git$/, '') });
    } else if ((m = line.match(/^clone_commit\s+(\S+)\s+(\S+)\s+(\S+)/))) {
      const [name] = splitDirVersion(m[1]);
      rows.push({ name, version: '—', detail: `commit ${m[2].slice(0, 12)}`, url: m[3].replace(/\.git$/, '') });
    } else if ((m = line.match(/^fetch_tar\s+(\S+)\s+(\S+)/))) {
      const [name, version] = splitDirVersion(m[1]);
      // A tarball has no project page to point at, so link the pinned source.
      rows.push({ name, version: version || '—', detail: '', url: m[2] });
    }
  }
  return rows;
}

// -------------------------------------------------------------- toolchain ----

function toolchain() {
  const emsdk = match1(read('deps', 'env.sh'), /emsdk activate\s+([0-9][0-9.]*)/);
  const qt = match1(read('.github', 'workflows', 'build.yml'), /QT_VERSION:\s*"?([0-9][0-9.]*)"?/);
  return [
    { name: 'Emscripten (emsdk)', version: emsdk || 'unknown', detail: 'compiles the whole C++ stack to WebAssembly', url: 'https://emscripten.org' },
    { name: 'Qt for WebAssembly', version: qt || 'unknown', detail: 'multithread build; hosts the gr-qtgui sinks', url: 'https://doc.qt.io/qt-6/wasm.html' },
    { name: 'Node.js', version: process.version.replace(/^v/, ''), detail: 'built the editor bundle', url: 'https://nodejs.org' },
  ];
}

// ------------------------------------------------- Python runtime (optional) --

/**
 * The Embedded Python Block's interpreter and the wheels beside it. Pinned in
 * fetch-pyodide.sh whether or not the optional download has been run, so this
 * reports what a Python Block *would* load.
 */
function pythonRuntime() {
  const sh = read('deps', 'fetch-pyodide.sh');
  const pyodide = match1(sh, /PYODIDE_VERSION="([^"]+)"/);
  const rows = [{
    name: 'Pyodide', version: pyodide || 'unknown',
    detail: 'CPython for WebAssembly (optional; fetched by deps/fetch-pyodide.sh)',
    url: 'https://pyodide.org',
  }];
  const wheels = sh.match(/^\s*"([A-Za-z0-9_.+-]+\.whl)\s/gm) || [];
  for (const w of wheels) {
    const file = match1(w, /"([^"\s]+)/);
    const [name, version] = file.split('-');
    rows.push({ name, version, detail: file, url: '' });
  }
  return rows;
}

// ------------------------------------------------------ editor web packages --

/**
 * The editor's direct npm dependencies at the versions actually installed, so a
 * caret range in package.json is reported as the resolved number rather than as
 * the range.
 */
function webPackages() {
  let pkg = {};
  try { pkg = JSON.parse(read('editor', 'package.json') || '{}'); } catch { /* keep {} */ }
  let lock = {};
  try { lock = JSON.parse(read('editor', 'package-lock.json') || '{}'); } catch { /* keep {} */ }
  const installed = name => lock.packages?.[`node_modules/${name}`]?.version || '';
  const rows = [];
  for (const [kind, deps] of [['runtime', pkg.dependencies], ['build', pkg.devDependencies]]) {
    for (const [name, range] of Object.entries(deps || {})) {
      rows.push({
        name, version: installed(name) || String(range).replace(/^[\^~]/, ''),
        detail: kind, url: `https://www.npmjs.com/package/${name}`,
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// --------------------------------------------------------------------- API ---

export function collectVersions() {
  const mods = submodules();
  const gr = mods.find(m => m.path === 'gnuradio');
  const oots = mods.filter(m => m.path !== 'gnuradio');
  return {
    app: appInfo(),
    groups: [
      {
        name: 'GNU Radio',
        note: 'The DSP stack itself, cross-compiled to WebAssembly.',
        rows: [{
          name: 'gnuradio',
          version: gnuradioVersion(),
          detail: gr ? submoduleRow(gr).detail : 'unknown',
          url: gr?.url || 'https://www.gnuradio.org',
        }],
      },
      {
        name: 'Out-of-tree modules',
        note: 'Vendored as submodules and compiled as on-demand WASM side modules.',
        rows: oots.map(submoduleRow),
      },
      {
        name: 'Toolchain',
        note: 'What compiled the stack. Pinned in deps/env.sh and the build workflow.',
        rows: toolchain(),
      },
      {
        name: 'C++ dependencies',
        note: 'Cross-built into sysroot/ by deps/build-deps.sh. Versions pinned in deps/fetch-deps.sh.',
        rows: cppDeps(),
      },
      {
        name: 'Python runtime',
        note: 'Loaded only by a flowgraph containing an Embedded Python Block.',
        rows: pythonRuntime(),
      },
      {
        name: 'Editor packages',
        note: 'npm dependencies of the flowgraph editor and the recording viewer.',
        rows: webPackages(),
      },
    ],
  };
}

// `node editor/gen/gen_versions.mjs` prints the collected JSON.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.stdout.write(JSON.stringify(collectVersions(), null, 2) + '\n');
}
