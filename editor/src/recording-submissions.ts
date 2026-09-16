import type { ExampleRecording } from './recording-catalog';

export const RECORDING_UPLOAD_API = String(
  import.meta.env.VITE_RECORDING_UPLOAD_API || 'https://recording-submissions.gnuradioworld.com',
).replace(/\/+$/, '');

export const RECORDING_REVIEW_API = String(
  import.meta.env.VITE_RECORDING_REVIEW_API || 'https://review-recordings.gnuradioworld.com',
).replace(/\/+$/, '');

export interface TriageRecording {
  id: string;
  submissionId: string;
  base: string;
  virtualKey: string;
  name: string;
  title: string;
  datatype: string;
  sampleRate: number | null;
  author: string | null;
  description: string | null;
  frequency: number | null;
  byteLength: number;
  dataUrl: string;
  metadataUrl: string;
  productionKey: string | null;
}

export interface TriageSubmission {
  id: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  publicNotes: string;
  sourceUrl: string;
  license: string;
  recordings: TriageRecording[];
  contact?: { name: string; email: string; handle: string };
  reviewedAt?: number | null;
  reviewerEmail?: string | null;
  reviewReason?: string | null;
}

async function responseJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body.error || `HTTP ${response.status}`));
  return body;
}

export async function fetchTriageRecording(id: string): Promise<TriageRecording> {
  const response = await fetch(`${RECORDING_UPLOAD_API}/v1/triage/recordings/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  return (await responseJson(response)).recording;
}

export function triageAsExampleRecording(recording: TriageRecording): ExampleRecording {
  return {
    name: recording.virtualKey,
    title: recording.title || recording.name,
    dataFile: recording.virtualKey + '.sigmf-data',
    metaFile: recording.virtualKey + '.sigmf-meta',
    datatype: recording.datatype,
    sampleRate: recording.sampleRate,
    author: recording.author,
    description: recording.description,
    frequency: recording.frequency,
    annotationCount: 0,
    annotationLabels: [],
    captureDatetime: null,
    category: null,
    collection: 'Triage submissions',
    tags: ['triage'],
    thumbnailUrl: null,
    sampleCount: null,
    byteLength: recording.byteLength,
    downloadUrl: recording.dataUrl,
    metadataUrl: recording.metadataUrl,
  };
}

export function triageRecordingIdFromKey(key: string): string | null {
  const match = /^triage\/[^/]+\/([^/]+)\//.exec(key);
  return match ? match[1] : null;
}

export const triageTestUrl = (recordingId: string): string =>
  `${location.origin}/#triage=${encodeURIComponent(recordingId)}`;

