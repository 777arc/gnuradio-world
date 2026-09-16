import './recording-contribution.css';
import { displayBytes, displaySi, recordingViewUrl } from './recording-catalog';
import {
  RECORDING_REVIEW_API,
  RECORDING_UPLOAD_API,
  triageTestUrl,
  type TriageRecording,
  type TriageSubmission,
} from './recording-submissions';

const list = document.getElementById('triageList')!;
const status = document.getElementById('triageStatus')!;
const loadMore = document.getElementById('loadMore') as HTMLButtonElement;
const banner = document.getElementById('reviewBanner')!;
const reviewMode = new URLSearchParams(location.search).get('review') === '1';
const requestedSubmission = new URLSearchParams(location.hash.slice(1)).get('submission');
let cursor: string | null = null;
let loading = false;

const text = (tag: string, value: string, className = ''): HTMLElement => {
  const node = document.createElement(tag); node.textContent = value; node.className = className; return node;
};

async function request(base: string, path: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(base + path, {
    ...init,
    headers,
    cache: 'no-store',
    credentials: base === RECORDING_REVIEW_API ? 'include' : 'omit',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body.error || `HTTP ${response.status}`));
  return body;
}

function link(label: string, href: string, className = 'secondary'): HTMLAnchorElement {
  const node = document.createElement('a');
  node.textContent = label; node.href = href; node.className = className;
  node.target = '_blank'; node.rel = 'noopener noreferrer';
  return node;
}

function recordingCard(recording: TriageRecording): HTMLElement {
  const card = document.createElement('article'); card.className = 'triage-recording';
  const head = document.createElement('div'); head.className = 'triage-recording-head';
  head.append(text('strong', recording.title || recording.name), text('span', recording.name, 'muted'));
  const facts = [recording.datatype, displaySi(recording.sampleRate, 'S/s'),
    displaySi(recording.frequency, 'Hz'), displayBytes(recording.byteLength)].filter(value => value !== '—');
  card.append(head, text('div', facts.join(' · '), 'upload-facts'));
  if (recording.description) card.append(text('p', recording.description));
  const actions = document.createElement('div'); actions.className = 'triage-actions';
  actions.append(
    link('View signal', recordingViewUrl(recording.metadataUrl, recording.dataUrl, recording.name)),
    link('Test in GNU Radio World', triageTestUrl(recording.id), 'primary'),
    link('Download data', recording.dataUrl),
    link('Download metadata', recording.metadataUrl),
  );
  card.append(actions);
  return card;
}

function submissionCard(submission: TriageSubmission, reviewer = false): HTMLElement {
  const card = document.createElement('section'); card.className = 'triage-submission';
  card.id = `submission-${submission.id}`;
  const head = document.createElement('header');
  const age = new Date(submission.createdAt).toLocaleString();
  head.append(text('h2', `${submission.recordings.length} recording${submission.recordings.length === 1 ? '' : 's'}`),
    text('span', `Submitted ${age}`, 'muted'));
  card.append(head);
  if (submission.publicNotes) card.append(text('p', submission.publicNotes));
  const provenance = document.createElement('p'); provenance.className = 'muted';
  provenance.append(`License: ${submission.license || 'not specified'}`);
  if (submission.sourceUrl) {
    provenance.append(' · ');
    const source = link('Source', submission.sourceUrl, ''); provenance.append(source);
  }
  card.append(provenance);
  for (const recording of submission.recordings) card.append(recordingCard(recording));

  if (reviewer) {
    const contact = submission.contact;
    const privateLine = document.createElement('p'); privateLine.className = 'private-contact';
    privateLine.textContent = contact && (contact.name || contact.email || contact.handle)
      ? `Private uploader contact: ${[contact.name, contact.email, contact.handle].filter(Boolean).join(' · ')}`
      : 'No private contact information supplied.';
    card.append(privateLine);

    const fields = document.createElement('div'); fields.className = 'review-fields';
    const keyInputs = new Map<string, HTMLInputElement>();
    for (const recording of submission.recordings) {
      const label = document.createElement('label'); label.textContent = `Production key for ${recording.name}`;
      const input = document.createElement('input'); input.value = `community/${recording.name}`;
      label.append(input); fields.append(label); keyInputs.set(recording.id, input);
    }
    const reasonLabel = document.createElement('label'); reasonLabel.textContent = 'Reviewer note / rejection reason';
    const reason = document.createElement('textarea'); reasonLabel.append(reason); fields.append(reasonLabel);
    const actions = document.createElement('div'); actions.className = 'triage-actions';
    const approve = document.createElement('button'); approve.className = 'primary'; approve.textContent = 'Approve and publish';
    const reject = document.createElement('button'); reject.className = 'danger'; reject.textContent = 'Reject';
    const runAction = async (kind: 'approve' | 'reject') => {
      if (kind === 'reject' && !reason.value.trim()) {
        status.textContent = 'A rejection reason is required.'; reason.focus(); return;
      }
      if (!confirm(kind === 'approve'
        ? 'Publish every recording in this submission to the production bucket?'
        : 'Reject this submission and remove its triage files?')) return;
      approve.disabled = reject.disabled = true;
      try {
        const body = kind === 'approve' ? {
          confirm: 'approve', reason: reason.value,
          recordings: submission.recordings.map(recording => ({
            id: recording.id, productionKey: keyInputs.get(recording.id)!.value,
          })),
        } : { confirm: 'reject', reason: reason.value };
        await request(RECORDING_REVIEW_API,
          `/v1/admin/submissions/${encodeURIComponent(submission.id)}/${kind}`,
          { method: 'POST', body: JSON.stringify(body) });
        card.remove(); status.textContent = kind === 'approve'
          ? 'Submission published. The recording indexer will add it to the catalog.'
          : 'Submission rejected and its triage files removed.';
      } catch (error) {
        status.textContent = `Review action failed: ${error}`;
        approve.disabled = reject.disabled = false;
      }
    };
    approve.onclick = () => void runAction('approve');
    reject.onclick = () => void runAction('reject');
    actions.append(approve, reject); fields.append(actions); card.append(fields);
  }
  return card;
}

async function loadPublic(append = false) {
  if (loading) return; loading = true; loadMore.disabled = true;
  try {
    let submissions: TriageSubmission[];
    let next: string | null = null;
    if (requestedSubmission && !append) {
      const body = await request(RECORDING_UPLOAD_API,
        `/v1/triage/${encodeURIComponent(requestedSubmission)}`);
      submissions = [body.submission];
    } else {
      const body = await request(RECORDING_UPLOAD_API,
        `/v1/triage?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      submissions = body.submissions; next = body.nextCursor;
    }
    if (!append) list.replaceChildren();
    for (const submission of submissions) list.append(submissionCard(submission));
    cursor = next; loadMore.hidden = !cursor;
    status.textContent = list.childElementCount ? '' : 'No recordings are awaiting triage.';
    if (requestedSubmission) list.firstElementChild?.scrollIntoView({ block: 'start' });
  } catch (error) { status.textContent = `Could not load recording triage: ${error}`; }
  finally { loading = false; loadMore.disabled = false; }
}

async function loadReviewer() {
  banner.hidden = false;
  const signInUrl = `${RECORDING_REVIEW_API}/v1/admin/session?return=${encodeURIComponent(location.href)}`;
  banner.replaceChildren(text('strong', 'Reviewer mode'), document.createTextNode(' · '),
    link('Sign in or refresh Cloudflare Access', signInUrl, ''));
  try {
    const session = await request(RECORDING_REVIEW_API, '/v1/admin/session');
    banner.append(document.createTextNode(` · Signed in as ${session.reviewer}`));
    const body = await request(RECORDING_REVIEW_API, '/v1/admin/submissions?status=ready');
    list.replaceChildren(...body.submissions.map((item: TriageSubmission) => submissionCard(item, true)));
    status.textContent = body.submissions.length ? '' : 'No submissions are awaiting review.';
  } catch (error) {
    status.textContent = `Reviewer authorization is required: ${error}`;
  }
}

loadMore.onclick = () => void loadPublic(true);
void (reviewMode ? loadReviewer() : loadPublic());
