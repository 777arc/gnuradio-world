// Helpers for "contribute this flowgraph as an example": the editor is a static
// site with no backend and no credentials, so a contribution is a hand-off to
// GitHub's web "create new file" page. GitHub forks the repo for anyone without
// write access and turns the commit into a pull request, which means a community
// member needs nothing but a GitHub account.
//
// The example flowgraphs are picked up from the directory listing (server.mjs and
// scripts/assemble-site.mjs enumerate the folder), so a merged PR that only adds a
// .grc file is enough — there is no manifest to update.
export const EXAMPLES_REPO = {
  owner: '777arc',
  repo: 'gnuradio',
  branch: 'main',
  dir: 'wasm/example_flowgraphs',
};

const MAX_NAME = 64;

// Turn free-form user input (usually the flowgraph title) into a safe file name
// inside EXAMPLES_REPO.dir. Anything that could escape that directory or upset
// git/GitHub is stripped rather than rejected, so the dialog never dead-ends.
export function sanitizeExampleName(raw: string): string {
  let name = String(raw ?? '').trim();
  // Only the last path segment survives, which also disposes of "../" traversal.
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  name = name.replace(/\.grc$/i, '');
  name = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_');
  name = name.replace(/^[._-]+/, '').replace(/[._-]+$/, '');
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).replace(/[._-]+$/, '');
  return (name || 'flowgraph') + '.grc';
}

export function examplePath(name: string): string {
  return `${EXAMPLES_REPO.dir}/${sanitizeExampleName(name)}`;
}

// GitHub's new-file editor accepts the target path as a `filename` query param;
// the file body is pasted by the contributor (a `value=` prefill would blow past
// the request-line limit for anything but the smallest flowgraphs).
export function newExampleFileUrl(name: string): string {
  const { owner, repo, branch } = EXAMPLES_REPO;
  return `https://github.com/${owner}/${repo}/new/${branch}` +
    `?filename=${encodeURIComponent(examplePath(name))}`;
}
