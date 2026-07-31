import { TraceabilityOrigin } from '@/utils/sigmfMetadata';

// Upstream also declares the plugin API's request/response shapes here
// (PluginDefinition/PluginEndpoint/PluginParameters/JobStatus/JobOutput/...).
// Plugins are not part of this port, so those are gone.

export interface DataSource {
  type: string;
  name: string;
  description?: string;
  imageURL?: string;
  account: string; // azure storage account or S3 region
  container: string; // azure storage account or S3 bucket name
  sasToken?: string; // client-side azure blob only
  accountKey?: string; // client-side azure blob only
  owners?: string[];
  readers?: string[];
  public?: boolean;
}

export interface SmartQueryResult {
  parameters: object;
  results: TraceabilityOrigin[];
}

export interface IQDataSlice {
  index: number;
  iqArray: Float32Array;
}

export interface FFTParams {
  fftSize: number;
  windowFunction: string;
  magnitude_min: number;
  magnitude_max: number;
}

export const DEFAULT_FFT_PARAMETERS: FFTParams = {
  fftSize: 1024,
  windowFunction: 'hamming',
  magnitude_min: -20,
  magnitude_max: 20,
};

export enum ClientType {
  API = 'api',
  LOCAL = 'local',
  BLOB = 'azure_blob',
  URL = 'url',
}

export enum DataType {
  iq_ci8_le = 'iq/ci8_le',
  iq_ci16_le = 'iq/ci16_le',
  iq_cf32_le = 'iq/cf32_le',
  image_png = 'image/png',
  audio_wav = 'audio/wav',
  application_octet_stream = 'application/octet-stream',
  text_plain = 'text/plain',
}

export const CLIENT_TYPE_API = 'api';
export const CLIENT_TYPE_LOCAL = 'local';
export const CLIENT_TYPE_BLOB = 'azure_blob';
// Defined next to the rest of the url data source helpers, and re-exported here
// so it sits with the other client types. sigmfMetadata.ts needs it too, and
// importing Models from there would be circular.
export { CLIENT_TYPE_URL } from '@/utils/url-datasource';
