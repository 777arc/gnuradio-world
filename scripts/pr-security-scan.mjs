#!/usr/bin/env node
// Diff-scoped security scan for a pull request.
//
// This is the deterministic half of the PR security gate (CodeQL and
// dependency-review are the other two); it exists because the attacks this
// repository is actually exposed to are not the ones a generic taint analysis
// looks for. Nothing here processes user input at runtime -- the editor is a
// static site and the runner is a WASM sandbox -- so the realistic threat is a
// contributor slipping something into the *build*: a workflow that leaks the
// Cloudflare token, a submodule pointer moved to a fork they control, an npm
// postinstall script, a fetch() that ships the recording index somewhere.
// Those are all visible in the diff as text, which is what this scans.
//
//   node scripts/pr-security-scan.mjs --base <ref> --head <ref>
//
// Only ADDED lines are examined, so existing code never re-flags and a rule can
// be strict without a repo-wide cleanup first. Exits 1 if anything blocking was
// found, 0 otherwise (warnings annotate but do not fail). With --json / and or
// --markdown it also writes machine- and human-readable reports.
//
// Suppressing a finding: put `pr-security-scan: allow <rule-id>` in a comment on
// the offending line or the line directly above it. Repo-wide exemptions go in
// .github/pr-security-allow.txt as `<rule-id> <path-glob>` -- but note that
// editing either that file or this one is itself a reported finding, so a PR
// cannot quietly widen its own exemptions.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
// severity: "block" fails the job, "warn" annotates only.
// files:    optional predicate limiting the rule to certain paths.
// A rule's `test` gets the added line's text and returns a detail string (or
// true) when it matches.

const isWorkflow = (f) => f.startsWith(".github/workflows/") || f.startsWith(".github/actions/");
const isExecutable = (f) => /\.(ts|tsx|js|mjs|cjs|jsx|py|sh|bash|yml|yaml|cpp|cc|hpp|h|html|cmake)$/i.test(f) ||
  f === "CMakeLists.txt" || f.endsWith("/CMakeLists.txt");
const isJs = (f) => /\.(ts|tsx|js|mjs|cjs|jsx)$/i.test(f);
const isCxx = (f) => /\.(cpp|cc|cxx|hpp|hh|h)$/i.test(f);
const isShell = (f) => /\.(sh|bash)$/i.test(f) || isWorkflow(f);

// Action owners already trusted by this repository's workflows. A PR that
// reaches for anyone else's action is running their code with our token.
const TRUSTED_ACTION_OWNERS = new Set([
  "actions", "github", "cloudflare", "puppeteer", "docker", "astral-sh", "denoland",
]);

// A workflow only puts a secret at risk if a pull request can trigger it. The
// reusable build.yml declares `secrets:` and deploy-wasm.yml consumes them, and
// neither is reachable from a PR event -- that separation is the entire design
// of this repository's CI, so flagging them would train everyone to ignore the
// rule. Judged from the file's own `on:` block, which is why a rule needs the
// whole file and not just the line.
const prTriggered = (text) =>
  /^on:\s*$[\s\S]*?^\s{2}pull_request(_target)?\s*:/m.test(text || "") ||
  /^on:.*\bpull_request(_target)?\b/m.test(text || "");

const RULES = [
  // --- workflow / CI surface ------------------------------------------------
  {
    id: "workflow-pull-request-target",
    severity: "block",
    files: isWorkflow,
    test: (l) => /^\s*pull_request_target\s*:/.test(l) &&
      "pull_request_target runs with a write token and repository secrets against untrusted code",
  },
  {
    id: "workflow-secret-on-pr-path",
    severity: "block",
    files: (f, ctx) => isWorkflow(f) && prTriggered(ctx.fileText),
    test: (l) => /\$\{\{\s*secrets\./.test(l) &&
      "a secret referenced from a workflow a pull request can trigger is a secret a fork can exfiltrate",
  },
  {
    id: "workflow-self-hosted-runner",
    severity: "block",
    files: isWorkflow,
    test: (l) => /runs-on:.*self-hosted/.test(l) &&
      "a self-hosted runner executes fork code on persistent hardware",
  },
  {
    id: "workflow-untrusted-action",
    severity: "block",
    files: isWorkflow,
    test: (l) => {
      // `uses: ./.github/workflows/x.yml` is this repository calling itself.
      if (/^\s*-?\s*uses:\s*['"]?\.\.?\//.test(l)) return false;
      const m = l.match(/^\s*-?\s*uses:\s*['"]?([\w.-]+)\/([\w.-]+)/);
      if (!m || TRUSTED_ACTION_OWNERS.has(m[1])) return false;
      return `third-party action ${m[1]}/${m[2]} would run in this repository's CI`;
    },
  },
  {
    id: "workflow-persist-credentials",
    severity: "warn",
    files: isWorkflow,
    test: (l) => /persist-credentials:\s*true/.test(l) &&
      "leaves the job's token in .git/config where any later step can read it",
  },
  {
    id: "workflow-touched",
    severity: "warn",
    files: isWorkflow,
    test: () => "CI workflow changed — read the whole file, not just the diff",
  },

  // --- supply chain ---------------------------------------------------------
  {
    id: "submodule-url-changed",
    severity: "block",
    files: (f) => f === ".gitmodules",
    test: (l) => /^\s*url\s*=/.test(l) &&
      "a submodule URL change repoints a whole vendored source tree",
  },
  {
    id: "npm-lifecycle-script",
    severity: "block",
    files: (f) => path.basename(f) === "package.json",
    test: (l) => /"(pre|post)?(install|prepare|prepublish|publish)"\s*:/.test(l) &&
      "an npm lifecycle script runs on every `npm ci`, in CI, before any test",
  },
  {
    // Where a package actually came from is settled in the lockfile, whatever
    // the range in package.json says.
    id: "npm-nonregistry-source",
    severity: "block",
    files: (f) => path.basename(f) === "package-lock.json",
    test: (l) => {
      const m = l.match(/"resolved"\s*:\s*"([^"]*)"/);
      if (!m || /^https:\/\/registry\.npmjs\.org\//.test(m[1])) return false;
      return `dependency resolved from ${m[1]} rather than the npm registry`;
    },
  },
  {
    // A dependency *range* naming a repository or a path bypasses the registry
    // entirely. https is deliberately not matched here: package.json's homepage,
    // repository and bugs fields are all https and all harmless.
    id: "npm-nonregistry-range",
    severity: "block",
    files: (f) => path.basename(f) === "package.json",
    test: (l) => {
      const m = l.match(/:\s*"((?:git|git\+[\w.+-]+|github|file|link|portal|ssh):[^"]*)"/);
      return m && `dependency range ${m[1]} bypasses the npm registry`;
    },
  },
  {
    id: "npm-dependency-added",
    severity: "warn",
    files: (f) => path.basename(f) === "package.json",
    test: (l) => /^\s*"[@\w][\w@./-]*"\s*:\s*"[\^~>=<\d*]/.test(l) &&
      "new npm dependency — check what it is and who publishes it",
  },

  // --- remote code execution and obfuscation -------------------------------
  {
    id: "pipe-to-shell",
    severity: "block",
    test: (l) => /(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(l) &&
      "downloads and executes a remote script in one step",
  },
  {
    id: "eval-of-download",
    severity: "block",
    test: (l) => /\beval\s*[("`']*\s*\$\(\s*(curl|wget)/.test(l) &&
      "evaluates the body of a remote response",
  },
  {
    id: "decode-and-execute",
    severity: "block",
    test: (l) => (/base64\s+(-d|--decode|-D)[^|]*\|\s*(ba|z)?sh/.test(l) ||
      /\batob\s*\([^)]*\)[^;]*\b(eval|Function|import)\s*\(/.test(l) ||
      /\b(eval|Function)\s*\(\s*atob\s*\(/.test(l)) &&
      "decodes a blob and executes it",
  },
  {
    id: "opaque-blob",
    severity: "block",
    test: (l) => {
      // A long unbroken base64/hex run in a source file is either minified
      // vendor code (which belongs in a vendored directory, not a diff) or a
      // payload. Signal/filter taps are decimal with separators, so they miss.
      const m = l.match(/[A-Za-z0-9+/=]{220,}/);
      return m && `${m[0].length}-character opaque literal`;
    },
  },
  {
    id: "js-dynamic-eval",
    severity: "warn",
    files: isJs,
    test: (l) => /\b(eval\s*\(|new\s+Function\s*\()/.test(l) &&
      "evaluates code built at runtime",
  },
  {
    id: "native-shell-out",
    severity: "warn",
    files: isCxx,
    test: (l) => /\b(system|popen|execve|emscripten_run_script(_string)?)\s*\(/.test(l) &&
      "escapes the WASM sandbox boundary into the host or the page",
  },

  // --- exfiltration ---------------------------------------------------------
  {
    id: "beacon-send",
    severity: "block",
    files: isJs,
    test: (l) => /navigator\s*\.\s*sendBeacon\s*\(/.test(l) &&
      "sendBeacon posts data to a remote origin with no response and no trace",
  },
  {
    id: "env-read-in-app",
    severity: "warn",
    files: (f) => (f.startsWith("editor/src/") || f.startsWith("runner/src/")) && isJs(f),
    test: (l) => /\bprocess\s*\.\s*env\b/.test(l) &&
      "application code reading the build environment — Vite inlines it into the shipped bundle",
  },
  {
    id: "credential-literal",
    severity: "block",
    test: (l) => {
      const pats = [
        [/\bghp_[A-Za-z0-9]{30,}/, "GitHub token"],
        [/\bgithub_pat_[A-Za-z0-9_]{50,}/, "GitHub fine-grained token"],
        [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
        [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
        [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, "private key"],
      ];
      for (const [re, what] of pats) if (re.test(l)) return `${what} committed in the diff`;
      return false;
    },
  },

  // --- browser-security regressions specific to this build ------------------
  {
    id: "cross-origin-isolation",
    severity: "warn",
    // http-support.mjs is where the dev server and the browser tests get these
    // headers from; assemble-site.mjs writes the deployed _headers copy.
    files: (f) => f === "server.mjs" || f.endsWith("_headers") ||
      f.includes("assemble-site") || f.includes("http-support"),
    test: (l) => /Cross-Origin-(Opener|Embedder|Resource)-Policy|Content-Security-Policy/i.test(l) &&
      "the COOP/COEP headers are what make SharedArrayBuffer and pthreads work — and what isolate the preview origin",
  },
  {
    id: "postmessage-wildcard",
    severity: "warn",
    files: (f) => isJs(f) || f.endsWith(".html"),
    test: (l) => /postMessage\s*\([^)]*,\s*['"]\*['"]/.test(l) &&
      "posts to any origin; the editor and runner frames know each other's origin",
  },
  {
    id: "html-injection",
    severity: "warn",
    files: (f) => isJs(f) || f.endsWith(".html"),
    test: (l) => /\.(inner|outer)HTML\s*=|document\s*\.\s*write\s*\(|dangerouslySetInnerHTML/.test(l) &&
      "assigns markup from a string — check nothing flowgraph-derived reaches it",
  },
];

// Files whose *content* is exempt from the pattern rules because they are the
// scan itself: every rule above appears in them as a literal. They are never
// exempt from being reported as modified (see SELF rules below) -- a PR that
// edits the gate is exactly the PR a reviewer needs to look at.
const SELF_FILES = new Set([
  "scripts/pr-security-scan.mjs",
  "scripts/sarif-gate.mjs",
  "test/test_pr_security_scan.mjs",
  ".github/pr-security-allow.txt",
  ".github/codeql/config.yml",
]);

// ---------------------------------------------------------------------------
// Diff collection
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
}

// Added lines, with their file and post-image line number. `--unified=0` keeps
// context lines out so nothing unchanged can trip a rule.
function addedLines(base, head) {
  const out = git(["diff", "--no-color", "--unified=0", "--merge-base", base, head]);
  const lines = [];
  let file = null;
  let lineNo = 0;
  for (const raw of out.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? null : raw.slice(6); // strip "+++ b/"
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -\S+ \+(\d+)/);
      lineNo = m ? Number(m[1]) : 0;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      lines.push({ file, line: lineNo, text: raw.slice(1) });
      lineNo++;
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      lineNo++;
    }
  }
  return lines;
}

const fileCache = new Map();
function fileAt(rev, file) {
  const key = `${rev}:${file}`;
  if (!fileCache.has(key)) {
    let text = "";
    try { text = git(["show", key]); } catch { /* deleted, or binary */ }
    fileCache.set(key, text);
  }
  return fileCache.get(key);
}

function changedFiles(base, head) {
  return git(["diff", "--no-color", "--name-only", "--merge-base", base, head])
    .split("\n").filter(Boolean);
}

// Submodule pointer moves show up as a one-line diff of an opaque hash, which
// no text rule can judge. Report them by name so a reviewer can check where the
// new commit came from -- a fork's history is indistinguishable from upstream's
// until you look at the remote.
function submoduleMoves(base, head) {
  const out = git(["diff", "--no-color", "--submodule=short", "--merge-base", base, head]);
  const moves = [];
  let file = null;
  for (const raw of out.split("\n")) {
    const d = raw.match(/^diff --git a\/(\S+) b\//);
    if (d) { file = d[1]; continue; }
    const m = raw.match(/^\+Subproject commit ([0-9a-f]{7,40})/);
    if (m && file) moves.push({ file, sha: m[1] });
  }
  return moves;
}

// Hosts already reachable from the base revision. Anything else appearing in
// the diff is a genuinely new outbound destination, which is the shape every
// exfiltration takes; deriving the allowlist from the tree rather than hard
// coding one keeps it correct as the repo grows.
function baseHosts(base) {
  const hosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "example.com", "www.w3.org"]);
  let out = "";
  try {
    out = git(["grep", "-hoIE", "https?://[A-Za-z0-9._-]+", base]);
  } catch {
    return hosts; // no matches at all, or a rev we cannot read; fail open here
  }
  for (const m of out.split("\n")) {
    const h = m.replace(/^https?:\/\//, "").toLowerCase();
    if (h) hosts.add(h);
  }
  return hosts;
}

// ---------------------------------------------------------------------------
// Suppressions
// ---------------------------------------------------------------------------

function loadAllowlist(root) {
  const file = path.join(root, ".github", "pr-security-allow.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n")
    .map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean)
    .map((l) => {
      const [rule, glob] = l.split(/\s+/);
      return { rule, re: globToRegExp(glob || "**") };
    });
}

function globToRegExp(glob) {
  const src = glob.split("**").map((part) =>
    part.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"),
  ).join(".*");
  return new RegExp(`^${src}$`);
}

const INLINE_ALLOW = /pr-security-scan:\s*allow\s+([\w-]+)/;

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export function scan({ base, head, root = process.cwd() }) {
  const findings = [];
  const files = changedFiles(base, head);
  const allowlist = loadAllowlist(root);
  const allowed = (rule, file) => allowlist.some((a) => a.rule === rule && a.re.test(file));

  // The gate's own machinery, reported before anything else it might have
  // failed to report.
  for (const f of files) {
    if (SELF_FILES.has(f)) {
      findings.push({
        rule: "security-gate-modified", severity: "block", file: f, line: 1,
        detail: "this PR edits the PR security gate itself — review the change before trusting its result",
      });
    }
  }

  for (const { file, sha } of submoduleMoves(base, head)) {
    if (allowed("submodule-pointer-moved", file)) continue;
    findings.push({
      rule: "submodule-pointer-moved", severity: "warn", file, line: 1,
      detail: `now points at ${sha} — confirm that commit exists in the upstream remote, not only in a fork`,
    });
  }

  const lines = addedLines(base, head);
  const byFile = new Map();
  for (const l of lines) {
    if (!byFile.has(l.file)) byFile.set(l.file, []);
    byFile.get(l.file).push(l);
  }

  for (const [file, fileLines] of byFile) {
    if (SELF_FILES.has(file)) continue;
    // Some rules need the post-image of the whole file, not only the added
    // lines: whether a workflow is PR-triggered is decided by its `on:` block,
    // which a diff that touches one step does not contain.
    const ctx = { get fileText() { return fileAt(head, file); } };
    for (const rule of RULES) {
      if (rule.files && !rule.files(file, ctx)) continue;
      if (allowed(rule.id, file)) continue;
      // A file-level rule (no useful per-line signal) reports once.
      const oneShot = rule.id === "workflow-touched";
      for (const { line, text } of fileLines) {
        const hit = rule.test(text, file);
        if (!hit) continue;
        if (suppressed(rule.id, fileLines, line)) continue;
        findings.push({
          rule: rule.id, severity: rule.severity, file, line,
          detail: typeof hit === "string" ? hit : rule.id,
          evidence: text.trim().slice(0, 160),
        });
        if (oneShot) break;
      }
    }
  }

  // New outbound hosts, judged against the base revision.
  const known = baseHosts(base);
  const seen = new Set();
  for (const { file, line, text } of lines) {
    if (SELF_FILES.has(file)) continue;
    for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
      const host = m[1].toLowerCase();
      if (known.has(host) || seen.has(`${file}:${host}`)) continue;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes(".")) continue;
      if (allowed("new-outbound-host", file)) continue;
      if (suppressed("new-outbound-host", byFile.get(file) || [], line)) continue;
      seen.add(`${file}:${host}`);
      findings.push({
        rule: "new-outbound-host",
        // A host in prose is a link; a host in code or a workflow is a
        // destination something will actually talk to.
        severity: isExecutable(file) ? "block" : "warn",
        file, line,
        detail: `${host} does not appear anywhere in the base revision`,
        evidence: text.trim().slice(0, 160),
      });
    }
  }

  const order = { block: 0, warn: 1 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] ||
    a.file.localeCompare(b.file) || a.line - b.line);
  return findings;
}

// An inline `pr-security-scan: allow <rule>` on the line itself or the added
// line immediately above it.
function suppressed(ruleId, fileLines, lineNo) {
  for (const l of fileLines) {
    if (l.line !== lineNo && l.line !== lineNo - 1) continue;
    const m = l.text.match(INLINE_ALLOW);
    if (m && m[1] === ruleId) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function toMarkdown(findings, { base, head }) {
  if (findings.length === 0) {
    return "## PR security scan\n\nNo findings. Diff scanned for CI/supply-chain, " +
      "remote-execution, exfiltration and browser-isolation changes.\n";
  }
  const blocking = findings.filter((f) => f.severity === "block");
  const out = [
    "## PR security scan",
    "",
    blocking.length
      ? `**${blocking.length} blocking**, ${findings.length - blocking.length} advisory. ` +
        "A blocking finding is not an accusation — it is a change that needs a human to say it is intended."
      : `${findings.length} advisory finding(s); nothing blocking.`,
    "",
    "| | rule | where | why |",
    "|---|---|---|---|",
  ];
  for (const f of findings) {
    const icon = f.severity === "block" ? "🚫" : "⚠️";
    out.push(`| ${icon} | \`${f.rule}\` | \`${f.file}:${f.line}\` | ${f.detail} |`);
  }
  out.push("", `<sub>\`${base.slice(0, 12)}\`…\`${head.slice(0, 12)}\` · ` +
    "suppress with `pr-security-scan: allow <rule>` on the line, or an entry in " +
    "`.github/pr-security-allow.txt`</sub>");
  return out.join("\n") + "\n";
}

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ""), argv[i + 1]);
  const head = args.get("head") || "HEAD";
  const base = args.get("base") || "origin/main";

  const findings = scan({ base, head });
  const blocking = findings.filter((f) => f.severity === "block");

  for (const f of findings) {
    const level = f.severity === "block" ? "error" : "warning";
    const msg = `[${f.rule}] ${f.detail}${f.evidence ? ` — ${f.evidence}` : ""}`;
    console.log(`::${level} file=${f.file},line=${f.line},title=PR security scan::${msg}`);
  }

  const md = toMarkdown(findings, { base, head });
  if (args.get("markdown")) writeFileSync(args.get("markdown"), md);
  if (args.get("json")) writeFileSync(args.get("json"), JSON.stringify(findings, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: "a" });
  }
  console.log(md);

  console.log(`RESULT: ${blocking.length ? "SECURITY_SCAN_BLOCKED" : "SECURITY_SCAN_PASS"} ` +
    `(${blocking.length} blocking, ${findings.length - blocking.length} advisory)`);
  return blocking.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
