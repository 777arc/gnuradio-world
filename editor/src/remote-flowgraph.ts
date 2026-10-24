// Opening a .grc that lives at a web URL: File ▸ Open URL… and the #url= link.
//
// The editor fetches the file itself, straight from the browser, so the host
// has to answer a cross-origin request -- there is no proxy. That covers where
// flowgraphs are actually shared: raw.githubusercontent.com, Gist and GitLab's
// files API all send `Access-Control-Allow-Origin: *`. What a person pastes is
// usually the *page* for the file rather than the file, so those are rewritten
// to the raw form first. GitLab's own `/-/raw/` path sends no CORS header at
// all, which is why GitLab links go to its API instead.
//
// A flowgraph from here is untrusted exactly as an opened file is: its
// JavaScript still has to be accepted before it runs (see main.ts).

/** Large enough for any real flowgraph, small enough that a wrong link cannot hang the tab. */
export const MAX_REMOTE_FLOWGRAPH_BYTES = 8 * 1024 * 1024;

/**
 * The URL to fetch for what was typed or linked: an http(s) URL, with a GitHub,
 * Gist or GitLab page URL rewritten to its raw file. Throws on anything else.
 */
export function normalizeFlowgraphUrl(input: string): string {
  const text = String(input).trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('only http:// and https:// URLs can be opened');
  const parts = url.pathname.split('/').filter(Boolean);

  // github.com/<owner>/<repo>/(blob|raw)/<ref>/<path…>
  if (url.hostname === 'github.com' && parts.length >= 5 &&
      (parts[2] === 'blob' || parts[2] === 'raw')) {
    const [owner, repo, , ...rest] = parts;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join('/')}`;
  }

  // gist.github.com/<user>/<id> -- the gist's raw URL serves its first file.
  if (url.hostname === 'gist.github.com' && parts.length === 2)
    return `https://gist.githubusercontent.com/${parts[0]}/${parts[1]}/raw`;

  // gitlab.com/<group…>/<project>/-/(blob|raw)/<ref>/<path…>. The ref is taken
  // to be one segment: the page URL cannot tell a branch named a/b from a
  // directory, and a single-segment branch is by far the common case.
  if (url.hostname === 'gitlab.com') {
    const dash = parts.indexOf('-');
    if (dash >= 2 && (parts[dash + 1] === 'blob' || parts[dash + 1] === 'raw') &&
        parts.length >= dash + 4) {
      const project = encodeURIComponent(parts.slice(0, dash).map(decodeURIComponent).join('/'));
      const ref = encodeURIComponent(decodeURIComponent(parts[dash + 2]));
      const file = encodeURIComponent(parts.slice(dash + 3).map(decodeURIComponent).join('/'));
      return `https://gitlab.com/api/v4/projects/${project}/repository/files/${file}/raw?ref=${ref}`;
    }
  }

  url.hash = '';
  return url.href;
}

/** The .grc file name Save should write back to, out of the URL as linked. */
export function remoteFlowgraphFileName(input: string): string {
  let name = '';
  try {
    const parts = new URL(String(input).trim()).pathname.split('/').filter(Boolean);
    name = decodeURIComponent(parts[parts.length - 1] || '');
  } catch { /* fall through to the default */ }
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '');
  if (!name) return 'flowgraph.grc';
  return /\.grc$/i.test(name) ? name : name.replace(/\.(ya?ml|txt)$/i, '') + '.grc';
}

/**
 * The text of the flowgraph at `input`. The errors are written for the console
 * pane: a cross-origin refusal surfaces from fetch() as a bare "Failed to
 * fetch", which tells the reader nothing about what to do next.
 */
export async function fetchRemoteFlowgraph(
  input: string, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = normalizeFlowgraphUrl(input);
  let response: Response;
  try {
    response = await fetchImpl(url, { mode: 'cors', credentials: 'omit', cache: 'no-cache' });
  } catch {
    throw new Error(`could not fetch ${url} — the host may be offline, or it does not ` +
      'allow cross-origin requests (CORS). Links to GitHub, Gist and GitLab files work; ' +
      'for anything else, download the .grc and use File ▸ Open…');
  }
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_REMOTE_FLOWGRAPH_BYTES)
    throw new Error(`${url} is ${declared} bytes — too large to be a flowgraph`);
  const text = await response.text();
  if (text.length > MAX_REMOTE_FLOWGRAPH_BYTES)
    throw new Error(`${url} is too large to be a flowgraph`);
  if (/^\s*<(!doctype|html)\b/i.test(text))
    throw new Error(`${url} is a web page, not a .grc file — link to the raw file instead`);
  return text;
}
