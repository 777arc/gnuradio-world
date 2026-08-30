import type { SigMFMetadata } from './sigmfMetadata';

export interface SampleSelection {
  start: number;
  end: number;
  count: number;
}

export function sampleSelection(start: number, end: number, totalSamples: number): SampleSelection {
  const total = Math.max(0, Math.floor(Number(totalSamples) || 0));
  const first = Math.min(total, Math.max(0, Math.floor(Math.min(start, end))));
  const last = Math.min(total, Math.max(first, Math.ceil(Math.max(start, end))));
  return { start: first, end: last, count: last - first };
}

// The viewer works on cf32 I/Q after reading any SigMF datatype. Downloads use
// that same representation, written explicitly little-endian to match the new
// metadata rather than relying on the host byte order of Float32Array.
export function float32IqBytes(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(samples.length * 4);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; ++i) view.setFloat32(i * 4, samples[i], true);
  return bytes;
}

export function trimmedSigmfMetadata(
  meta: SigMFMetadata,
  selection: SampleSelection,
): Record<string, any> {
  const raw = JSON.parse(meta.getSigMFRaw());
  const global = { ...(raw.global ?? {}) };
  global['core:datatype'] = 'cf32_le';
  global['traceability:sample_length'] = selection.count;
  delete global['core:offset'];
  delete global['core:sha512'];
  delete global['core:dataset'];
  delete global['traceability:origin'];

  const originalCaptures = Array.isArray(raw.captures) ? raw.captures : [];
  let activeCapture: Record<string, any> | undefined;
  const laterCaptures: Record<string, any>[] = [];
  for (const capture of originalCaptures) {
    const sampleStart = Number(capture?.['core:sample_start'] ?? 0);
    if (sampleStart <= selection.start) activeCapture = capture;
    else if (sampleStart < selection.end) laterCaptures.push(capture);
  }
  const captures = [
    ...(activeCapture ? [{ ...activeCapture, 'core:sample_start': 0 }] : []),
    ...laterCaptures.map(capture => ({
      ...capture,
      'core:sample_start': Number(capture['core:sample_start']) - selection.start,
    })),
  ];

  const originalAnnotations = Array.isArray(raw.annotations) ? raw.annotations : [];
  const annotations: Record<string, any>[] = [];
  for (const annotation of originalAnnotations) {
    const sampleStart = Number(annotation?.['core:sample_start'] ?? 0);
    const hasCount = annotation?.['core:sample_count'] !== undefined;
    const sampleCount = Math.max(0, Number(annotation?.['core:sample_count'] ?? 0));
    if (!hasCount || sampleCount === 0) {
      if (sampleStart >= selection.start && sampleStart < selection.end) {
        annotations.push({ ...annotation, 'core:sample_start': sampleStart - selection.start });
      }
      continue;
    }
    const overlapStart = Math.max(selection.start, sampleStart);
    const overlapEnd = Math.min(selection.end, sampleStart + sampleCount);
    if (overlapEnd <= overlapStart) continue;
    annotations.push({
      ...annotation,
      'core:sample_start': overlapStart - selection.start,
      'core:sample_count': overlapEnd - overlapStart,
    });
  }

  return { global, captures, annotations };
}
