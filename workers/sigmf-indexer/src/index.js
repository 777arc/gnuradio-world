const DATA_SUFFIX = '.sigmf-data';
const META_SUFFIX = '.sigmf-meta';
export const INDEX_KEY = 'index.json';

/**
 * Return the number of bytes occupied by one SigMF sample.
 *
 * SigMF datatypes are r/c (real/complex), f/i/u (float/signed/unsigned), a
 * component bit width, and an optional byte order. A complex sample contains
 * two components.
 */
export function sigmfBytesPerSample(datatype) {
  const match = typeof datatype === 'string'
    ? /^([rc])[fiu](\d+)(?:_(?:le|be))?$/i.exec(datatype)
    : null;
  if (!match) return null;

  const componentCount = match[1].toLowerCase() === 'c' ? 2 : 1;
  const bytes = componentCount * Number(match[2]) / 8;
  return Number.isInteger(bytes) && bytes > 0 ? bytes : null;
}

function optionalString(value) {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordingFromMetadata(baseFilename, dataSize, metadata) {
  const global = metadata && typeof metadata.global === 'object' && metadata.global !== null
    ? metadata.global
    : {};
  const captures = Array.isArray(metadata?.captures) ? metadata.captures : [];
  const firstCaptureWithFrequency = captures.find(capture =>
    capture && typeof capture === 'object' &&
    typeof capture['core:frequency'] === 'number' &&
    Number.isFinite(capture['core:frequency']));

  const datatype = optionalString(global['core:datatype']);
  const bytesPerSample = sigmfBytesPerSample(datatype);
  const numberOfSamples = bytesPerSample !== null && dataSize % bytesPerSample === 0
    ? dataSize / bytesPerSample
    : null;

  return {
    base_filename: baseFilename,
    datatype,
    sample_rate: optionalNumber(global['core:sample_rate']),
    author: optionalString(global['core:author']),
    description: optionalString(global['core:description']),
    frequency: firstCaptureWithFrequency
      ? firstCaptureWithFrequency['core:frequency']
      : null,
    byte_length: dataSize,
    number_of_samples: numberOfSamples,
    number_of_annotations: Array.isArray(metadata?.annotations)
      ? metadata.annotations.length
      : 0,
  };
}

async function listAllObjects(bucket, logger) {
  const objects = [];
  let cursor;
  let pageNumber = 0;

  do {
    pageNumber++;
    const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    objects.push(...page.objects);
    logger.log('R2 list page', {
      page: pageNumber,
      objects: page.objects.length,
      truncated: page.truncated,
      first_key: page.objects[0]?.key ?? null,
      last_key: page.objects.at(-1)?.key ?? null,
    });
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && !cursor) {
      throw new Error('R2 returned a truncated object listing without a cursor');
    }
  } while (cursor);

  return objects;
}

function classifySigmfObject(object) {
  const lowerKey = object.key.toLowerCase();
  if (lowerKey.endsWith(DATA_SUFFIX)) {
    return { type: 'data', base: object.key.slice(0, -DATA_SUFFIX.length), object };
  }
  if (lowerKey.endsWith(META_SUFFIX)) {
    return { type: 'meta', base: object.key.slice(0, -META_SUFFIX.length), object };
  }
  return null;
}

function sampleKeys(keys, limit = 10) {
  return keys.slice(0, limit);
}

async function mapConcurrent(items, concurrency, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await operation(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

/** Build and replace index.json in the bound recordings bucket. */
export async function rebuildIndex(bucket, { logger = console } = {}) {
  logger.log('SigMF index refresh started', { index_key: INDEX_KEY });
  const objects = await listAllObjects(bucket, logger);
  const pairs = new Map();
  let dataObjects = 0;
  let metaObjects = 0;

  for (const object of objects) {
    const classified = classifySigmfObject(object);
    if (!classified) continue;
    const pair = pairs.get(classified.base) ?? {};
    pair[classified.type] = classified.object;
    pairs.set(classified.base, pair);
    if (classified.type === 'data') dataObjects++;
    else metaObjects++;
  }

  const recordings = [...pairs]
    .filter(([, pair]) => pair.data && pair.meta)
    .map(([base]) => base)
    .sort((a, b) => a.localeCompare(b));
  const unmatchedMeta = [...pairs]
    .filter(([, pair]) => pair.meta && !pair.data)
    .map(([, pair]) => pair.meta.key);
  const unmatchedData = [...pairs]
    .filter(([, pair]) => pair.data && !pair.meta)
    .map(([, pair]) => pair.data.key);

  logger.log('R2 SigMF scan summary', {
    total_objects: objects.length,
    data_objects: dataObjects,
    metadata_objects: metaObjects,
    matched_recordings: recordings.length,
    other_objects: objects.length - dataObjects - metaObjects,
  });
  if (unmatchedData.length) {
    logger.warn('SigMF data objects without matching metadata', {
      count: unmatchedData.length,
      sample_keys: sampleKeys(unmatchedData),
    });
  }
  if (unmatchedMeta.length) {
    logger.warn('SigMF metadata objects without matching data', {
      count: unmatchedMeta.length,
      sample_keys: sampleKeys(unmatchedMeta),
    });
  }

  // A bucket containing SigMF-looking objects but no complete pair is normally
  // an upload/layout mistake. Do not replace a useful old index with [] in that
  // situation; keep it and make the problem explicit in the Worker logs.
  if (recordings.length === 0 && (dataObjects > 0 || metaObjects > 0)) {
    throw new Error(
      `Found ${dataObjects} .sigmf-data and ${metaObjects} .sigmf-meta objects, ` +
      'but no matching base filenames; index.json was not replaced',
    );
  }

  // Bound concurrency avoids issuing an unbounded burst of R2 reads for a
  // large collection. Any read or parse failure rejects the refresh before the
  // put, retaining the previously generated index.
  const index = await mapConcurrent(recordings, 16, async base => {
    const pair = pairs.get(base);
    const metaKey = pair.meta.key;
    const metaObject = await bucket.get(metaKey);
    const dataObject = pair.data;
    if (!metaObject) throw new Error(`Metadata object disappeared during scan: ${metaKey}`);

    let metadata;
    try {
      metadata = JSON.parse(await metaObject.text());
    } catch (error) {
      throw new Error(`Invalid JSON in ${metaKey}`, { cause: error });
    }
    return recordingFromMetadata(base, dataObject.size, metadata);
  });

  const body = JSON.stringify(index, null, 2) + '\n';
  await bucket.put(INDEX_KEY, body, {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-cache',
    },
  });

  logger.log('SigMF index refresh completed', {
    index_key: INDEX_KEY,
    recordings: index.length,
    bytes: new TextEncoder().encode(body).byteLength,
  });
  return index;
}

export default {
  async scheduled(controller, env) {
    console.log('Cron trigger received', {
      cron: controller.cron,
      scheduled_time: new Date(controller.scheduledTime).toISOString(),
    });
    await rebuildIndex(env.RECORDINGS);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/rebuild') {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (request.method !== 'POST') {
      return Response.json(
        { error: 'Use POST /rebuild' },
        { status: 405, headers: { Allow: 'POST' } },
      );
    }
    if (!env.REBUILD_TOKEN) {
      console.error('Manual rebuild rejected: REBUILD_TOKEN is not configured');
      return Response.json({ error: 'Manual rebuild is not configured' }, { status: 503 });
    }
    if (request.headers.get('Authorization') !== `Bearer ${env.REBUILD_TOKEN}`) {
      console.warn('Unauthorized manual rebuild request');
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('Authenticated manual rebuild requested');
    try {
      const index = await rebuildIndex(env.RECORDINGS);
      return Response.json({ ok: true, recordings: index.length, index_key: INDEX_KEY });
    } catch (error) {
      console.error('Manual rebuild failed', error);
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 },
      );
    }
  },
};
