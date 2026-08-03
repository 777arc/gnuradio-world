import { SigMFMetadata } from '@/utils/sigmfMetadata';
import { UrlClient } from './url-client';
import { assertUrlRecordingType } from '@/utils/url-datasource';
import { useQuery } from '@tanstack/react-query';

export const useMeta = (type: string, account: string, container: string, filePath: string) => {
  assertUrlRecordingType(type);
  const metadataClient = new UrlClient();
  return useQuery<SigMFMetadata>({
    queryKey: ['datasource', type, account, container, filePath, 'meta'],
    queryFn: () => {
      return metadataClient.getMeta(account, container, filePath);
    },
  });
};
