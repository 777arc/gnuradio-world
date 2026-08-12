#!/usr/bin/env node
// Turn a CodeQL SARIF run into a pass/fail gate for one pull request.
//
// CodeQL by itself never fails a job -- it files alerts and moves on, which is
// right for a repository-wide scan and useless as a PR gate. This reduces the
// run to the alerts a PR is responsible for: high or critical severity, in a
// file that PR actually changed. Anything pre-existing stays an alert in the
// Security tab, where it belongs, instead of blocking every contributor over
// debt they did not create.
//
//   node scripts/sarif-gate.mjs --sarif <dir-or-file> --files <changed.txt>
//
// Exits 1 if any qualifying result was found.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ""), argv[i + 1]);

const target = args.get("sarif");
const changed = new Set(
  readFileSync(args.get("files"), "utf8").split("\n").map((l) => l.trim()).filter(Boolean),
);
// CodeQL's own scale: security-severity is CVSS-like, 7.0 and up is high.
const threshold = Number(args.get("threshold") || 7.0);

function sarifFiles(p) {
  if (statSync(p).isFile()) return [p];
  return readdirSync(p).filter((f) => f.endsWith(".sarif")).map((f) => path.join(p, f));
}

const findings = [];
for (const file of sarifFiles(target)) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  for (const run of doc.runs || []) {
    // The rule metadata carrying security-severity lives in the driver, keyed
    // by rule id; results only reference it.
    const rules = new Map();
    for (const r of run.tool?.driver?.rules || []) rules.set(r.id, r);
    for (const ext of run.tool?.extensions || []) {
      for (const r of ext.rules || []) rules.set(r.id, r);
    }
    for (const res of run.results || []) {
      const rule = rules.get(res.ruleId) || {};
      const sev = Number(rule.properties?.["security-severity"] ?? NaN);
      if (!(sev >= threshold)) continue;
      const loc = res.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri;
      if (!uri || !changed.has(uri)) continue;
      findings.push({
        rule: res.ruleId,
        severity: sev,
        file: uri,
        line: loc?.region?.startLine ?? 1,
        message: res.message?.text || rule.shortDescription?.text || res.ruleId,
      });
    }
  }
}

for (const f of findings) {
  console.log(`::error file=${f.file},line=${f.line},title=CodeQL ${f.rule}::` +
    `[security-severity ${f.severity}] ${f.message.replace(/\s+/g, " ")}`);
}

const md = findings.length
  ? ["## CodeQL", "", `${findings.length} high-severity alert(s) in files this PR changed.`, "",
    "| rule | where | message |", "|---|---|---|",
    ...findings.map((f) => `| \`${f.rule}\` | \`${f.file}:${f.line}\` | ${f.message.replace(/\s+/g, " ").slice(0, 200)} |`),
    ""].join("\n")
  : "## CodeQL\n\nNo high-severity alerts in the files this PR changed.\n";

if (args.get("markdown")) writeFileSync(args.get("markdown"), md);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: "a" });
console.log(md);
console.log(`RESULT: ${findings.length ? "CODEQL_GATE_BLOCKED" : "CODEQL_GATE_PASS"} (${findings.length})`);
process.exit(findings.length ? 1 : 0);
