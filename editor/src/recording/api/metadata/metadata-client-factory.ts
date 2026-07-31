import { CLIENT_TYPE_URL } from '@/api/Models';
import { UrlClient } from './url-client';
import { MetadataClient } from './metadata-client';

// Only the 'url' client survives the port; see IQDataClientFactory for why.
export const MetadataClientFactory = (type: string): MetadataClient => {
  switch (type) {
    case CLIENT_TYPE_URL:
      return new UrlClient();
    default:
      throw new Error(`Unknown data source type: ${type}`);
  }
};
