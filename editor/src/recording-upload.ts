import './recording-contribution.css';
import {
  pairSigmfFileBatch,
  validateSigmfPair,
  SIGMF_SUBMISSION_LIMIT,
  type ValidatedSigmfPair,
} from './sigmf-files';
import { RECORDING_UPLOAD_API } from './recording-submissions';

declare global {
  interface Window {
    turnstile?: {
      render(element: HTMLElement, options: Record<string, unknown>): string;
      reset(widget?: string): void;
    };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>('recordingFiles');
const drop = $('uploadDrop');
const errors = $('uploadErrors');
const rows = $('uploadRows');
const uploadButton = $<HTMLButtonElement>('uploadButton');
const cancelButton = $<HTMLButtonElement>('cancelButton');
const status = $('uploadStatus');
const disabledReason = $('uploadDisabledReason');
const overall = $<HTMLProgressElement>('overallProgress');
const complete = $('uploadComplete');
const rights = $<HTMLInputElement>('rights');

let pairs: ValidatedSigmfPair[] = [];
let validating = false;
let uploading = false;
let cancelled = false;
let turnstileToken = '';
let turnstileWidget = '';
let turnstileLoaded = false;
let turnstileProblem = '';
let selectionHasProblems = false;
let activeSession: { id: string; capability: string } | null = null;
const activeRequests = new Set<XMLHttpRequest>();
const transferred = new Map<string, number>();

const displayBytes = (bytes: number): string => {
  const units = ['B', 'MB', 'GB']; let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
};

function showErrors(messages: string[]) {
  errors.replaceChildren(...messages.map(message => {
    const item = document.createElement('li'); item.textContent = message; return item;
  }));
}

function refreshReady() {
  let reason = '';
  if (validating) reason = 'Checking the selected files…';
  else if (uploading) reason = 'An upload is already in progress.';
  else if (!pairs.length) reason = selectionHasProblems
    ? 'Fix the file selection errors shown above.'
    : 'Choose at least one complete .sigmf-data and .sigmf-meta pair.';
  else if (!rights.checked) reason = 'Confirm that you have permission to share the recordings.';
  else if (turnstileProblem) reason = turnstileProblem;
  else if (!turnstileLoaded) reason = 'Human verification is still loading.';
  else if (!turnstileToken) reason = 'Complete the human verification challenge.';
  uploadButton.disabled = !!reason;
  uploadButton.title = reason;
  disabledReason.textContent = reason ? `Upload unavailable: ${reason}` : '';
  disabledReason.hidden = !reason;
}

function renderRows() {
  rows.replaceChildren(...pairs.map(pair => {
    const row = document.createElement('article'); row.className = 'upload-row';
    row.dataset.base = pair.base;
    const head = document.createElement('div'); head.className = 'upload-row-head';
    const name = document.createElement('strong'); name.textContent = pair.base;
    const facts = document.createElement('span'); facts.className = 'upload-facts';
    facts.textContent = `${pair.metadata.datatype} · ${pair.metadata.sampleRate?.toLocaleString() || 'rate unknown'} S/s · ` +
      `${displayBytes(pair.data.size)} data · ${displayBytes(pair.meta.size)} metadata`;
    head.append(name, facts);
    const note = document.createElement('span'); note.className = 'muted upload-note';
    note.textContent = pair.warning || 'Ready to upload';
    const progress = document.createElement('progress'); progress.max = pair.totalSize; progress.value = 0;
    progress.hidden = true;
    row.append(head, note, progress); return row;
  }));
}

async function validateSelection(files: File[]) {
  validating = true; selectionHasProblems = false;
  pairs = []; renderRows(); showErrors([]); refreshReady();
  const grouped = pairSigmfFileBatch(files);
  const problems = [...grouped.errors];
  const validated: ValidatedSigmfPair[] = [];
  for (const pair of grouped.pairs) {
    const result = await validateSigmfPair(pair);
    if ('error' in result) problems.push(result.error);
    else validated.push(result);
  }
  const total = validated.reduce((sum, pair) => sum + pair.totalSize, 0);
  if (total > SIGMF_SUBMISSION_LIMIT)
    problems.push(`The selection is ${displayBytes(total)}; one submission is limited to 2 GB.`);
  selectionHasProblems = problems.length > 0;
  pairs = problems.length ? [] : validated;
  showErrors(problems); renderRows(); validating = false; refreshReady();
}

fileInput.onchange = () => void validateSelection([...fileInput.files || []]);
for (const eventName of ['dragenter', 'dragover']) drop.addEventListener(eventName, event => {
  event.preventDefault(); drop.classList.add('dragging');
});
for (const eventName of ['dragleave', 'drop']) drop.addEventListener(eventName, event => {
  event.preventDefault(); drop.classList.remove('dragging');
});
drop.addEventListener('drop', event => {
  const data = event as DragEvent;
  if (data.dataTransfer?.files.length) void validateSelection([...data.dataTransfer.files]);
});
rights.onchange = refreshReady;

async function api(path: string, init: RequestInit = {}, capability?: string): Promise<any> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  if (capability) headers.set('Authorization', `Bearer ${capability}`);
  const response = await fetch(RECORDING_UPLOAD_API + path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body.error || `HTTP ${response.status}`));
  return body;
}

function updateProgress(total: number) {
  const sent = [...transferred.values()].reduce((sum, value) => sum + value, 0);
  overall.value = sent; overall.max = total;
  status.textContent = `Uploading ${displayBytes(sent)} of ${displayBytes(total)}…`;
  for (const pair of pairs) {
    const progress = rows.querySelector<HTMLElement>(`[data-base="${CSS.escape(pair.base)}"] progress`);
    if (!progress) continue;
    let pairSent = 0;
    for (const [key, value] of transferred)
      if (key.startsWith(pair.base + ':')) pairSent += value;
    (progress as HTMLProgressElement).value = pairSent;
  }
}

function xhrUpload(url: string, body: Blob, capability: string, progressKey: string,
                   total: number): Promise<any> {
  return new Promise((resolve, reject) => {
    if (cancelled) { reject(new Error('Upload cancelled')); return; }
    const xhr = new XMLHttpRequest(); activeRequests.add(xhr);
    xhr.open('PUT', url); xhr.responseType = 'json';
    xhr.setRequestHeader('Authorization', `Bearer ${capability}`);
    xhr.upload.onprogress = event => {
      transferred.set(progressKey, event.loaded); updateProgress(total);
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response || {});
      else reject(new Error(String(xhr.response?.error || `HTTP ${xhr.status}`)));
    };
    xhr.onloadend = () => activeRequests.delete(xhr);
    xhr.send(body);
  });
}

async function retry<T>(operation: () => Promise<T>, progressKey: string): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await operation(); }
    catch (error) {
      last = error; transferred.set(progressKey, 0);
      if (cancelled || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw last;
}

async function runPool(tasks: Array<() => Promise<void>>, concurrency: number) {
  let next = 0;
  async function worker() {
    while (next < tasks.length) { const task = tasks[next++]; await task(); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

async function startUpload() {
  if (uploadButton.disabled) return;
  uploading = true; cancelled = false; transferred.clear(); refreshReady();
  status.classList.remove('success');
  cancelButton.hidden = false; overall.hidden = false; complete.hidden = true;
  for (const progress of rows.querySelectorAll<HTMLProgressElement>('progress')) progress.hidden = false;
  const total = pairs.reduce((sum, pair) => sum + pair.totalSize, 0);
  try {
    status.textContent = 'Creating the upload…';
    const created = await api('/v1/submissions', { method: 'POST', body: JSON.stringify({
      turnstileToken,
      recordings: pairs.map(pair => ({ base: pair.base, dataSize: pair.data.size, metaSize: pair.meta.size })),
      publicNotes: $<HTMLTextAreaElement>('publicNotes').value,
      sourceUrl: $<HTMLInputElement>('sourceUrl').value,
      license: $<HTMLSelectElement>('license').value,
      contact: {
        name: $<HTMLInputElement>('contactName').value,
        email: $<HTMLInputElement>('contactEmail').value,
        handle: $<HTMLInputElement>('contactHandle').value,
      },
    }) });
    activeSession = { id: created.submissionId, capability: created.capability };
    const remoteByBase = new Map(created.recordings.map((item: any) => [item.base, item]));
    const uploadedParts = new Map<string, any[]>();
    const tasks: Array<() => Promise<void>> = [];
    for (const pair of pairs) {
      const remote: any = remoteByBase.get(pair.base);
      const parts: any[] = []; uploadedParts.set(pair.base, parts);
      for (let index = 0; index < remote.partCount; index++) {
        const start = index * created.partSize;
        const blob = pair.data.slice(start, Math.min(pair.data.size, start + created.partSize));
        const progressKey = `${pair.base}:data:${index}`;
        tasks.push(async () => {
          const result = await retry(() => xhrUpload(
            `${RECORDING_UPLOAD_API}/v1/submissions/${created.submissionId}/recordings/${remote.id}/data/parts/${index + 1}`,
            blob, created.capability, progressKey, total), progressKey);
          parts.push(result);
        });
      }
      const metaKey = `${pair.base}:meta`;
      tasks.push(async () => {
        await retry(() => xhrUpload(
          `${RECORDING_UPLOAD_API}/v1/submissions/${created.submissionId}/recordings/${remote.id}/meta`,
          pair.meta, created.capability, metaKey, total), metaKey);
      });
    }
    await runPool(tasks, 3);
    for (const pair of pairs) {
      const remote: any = remoteByBase.get(pair.base);
      await api(`/v1/submissions/${created.submissionId}/recordings/${remote.id}/data/complete`, {
        method: 'POST', body: JSON.stringify({ parts: uploadedParts.get(pair.base) }),
      }, created.capability);
    }
    const result = await api(`/v1/submissions/${created.submissionId}/complete`, {
      method: 'POST', body: '{}',
    }, created.capability);
    transferred.clear(); for (const pair of pairs) transferred.set(`${pair.base}:done`, pair.totalSize);
    updateProgress(total); status.textContent = 'Upload complete and ready for triage.';
    status.classList.add('success');
    complete.hidden = false;
    const link = `${location.origin}/recordings/triage/#submission=${encodeURIComponent(result.submission.id)}`;
    complete.replaceChildren(document.createTextNode('Submission link: '));
    const anchor = document.createElement('a'); anchor.href = link; anchor.textContent = link;
    complete.append(anchor); activeSession = null;
  } catch (error) {
    const userCancelled = cancelled;
    cancelled = true;
    for (const xhr of activeRequests) xhr.abort();
    status.textContent = userCancelled ? 'Upload cancelled.' : `Upload failed: ${error}`;
    if (!userCancelled) status.classList.remove('success');
    if (activeSession) {
      await api(`/v1/submissions/${activeSession.id}`, { method: 'DELETE' }, activeSession.capability)
        .catch(() => {});
      activeSession = null;
    }
  } finally {
    uploading = false; cancelButton.hidden = true;
    if (turnstileWidget && window.turnstile) window.turnstile.reset(turnstileWidget);
    turnstileToken = '';
    refreshReady();
  }
}

async function cancelUpload() {
  if (!uploading) return;
  cancelled = true; for (const xhr of activeRequests) xhr.abort();
  if (activeSession) {
    await api(`/v1/submissions/${activeSession.id}`, { method: 'DELETE' }, activeSession.capability)
      .catch(() => {});
    activeSession = null;
  }
}

uploadButton.onclick = () => void startUpload();
cancelButton.onclick = () => void cancelUpload();
window.addEventListener('beforeunload', event => {
  if (!uploading) return; event.preventDefault(); event.returnValue = '';
});

function loadTurnstile() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const sitekey = String(import.meta.env.VITE_TURNSTILE_SITE_KEY || (local ? '1x00000000000000000000AA' : ''));
  if (!sitekey) {
    turnstileProblem = 'Human verification is not configured on this deployment.';
    refreshReady(); return;
  }
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true; script.defer = true;
  script.onload = () => {
    if (typeof window.turnstile?.render !== 'function') {
      turnstileProblem = 'Human verification could not initialize; reload the page to try again.';
      refreshReady(); return;
    }
    turnstileLoaded = true;
    turnstileWidget = window.turnstile.render($('turnstileMount'), {
      sitekey, theme: 'dark', action: 'recording-upload',
      callback: (token: string) => {
        turnstileProblem = ''; turnstileToken = token; refreshReady();
      },
      'expired-callback': () => { turnstileToken = ''; refreshReady(); },
      'error-callback': () => {
        turnstileToken = '';
        turnstileProblem = 'Human verification could not load; reload the page to try again.';
        refreshReady();
      },
    });
    refreshReady();
  };
  script.onerror = () => {
    turnstileProblem = 'Human verification could not load; check your connection and reload the page.';
    refreshReady();
  };
  document.head.append(script);
}

refreshReady();
loadTurnstile();
