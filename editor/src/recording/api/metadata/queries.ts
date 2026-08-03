import { SigMFMetadata } from '@/utils/sigmfMetadata';
import { MetadataClientFactory } from './metadata-client-factory';
import { useQuery } from '@tanstack/react-query';

export const useMeta = (type: string, account: string, container: string, filePath: string) => {
  const metadataClient = MetadataClientFactory(type);
  return useQuery<SigMFMetadata>({
    queryKey: ['datasource', type, account, container, filePath, 'meta'],
    queryFn: () => {
      return metadataClient.getMeta(account, container, filePath);
    },
  });
};
