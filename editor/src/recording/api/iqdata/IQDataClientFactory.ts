import { CLIENT_TYPE_URL } from '@/api/Models';
import { UrlClient } from './UrlClient';
import { IQDataClient } from './IQDataClient';

// Upstream IQEngine also has api / local / azure_blob clients, which need a
// backend, a picked directory or an Azure account respectively. Nothing here
// has any of those: a recording reaches this viewer as a pair of URLs (see
// @/utils/url-datasource), and a local file picked in the editor is handed over
// as a pair of blob: URLs, read through this very same client.
export const IQDataClientFactory = (type: string): IQDataClient => {
  switch (type) {
    case CLIENT_TYPE_URL:
      return new UrlClient();
    default:
      throw new Error(`Unknown data source type: ${type}`);
  }
};
