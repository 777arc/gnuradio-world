import { SigMFMetadata } from '@/utils/sigmfMetadata';
import { MetadataClientFactory } from './metadata-client-factory';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MetadataClient } from './metadata-client';

// Upstream gates every one of these on useUserSettings()/useMsal()/useConfigQuery(),
// which exist to pick between the api / local / azure_blob clients and to hand
// them credentials. With only the 'url' client left there is nothing to pick and
// no credential to pass, so the client is built straight from the type and the
// queries are enabled unconditionally.

export const fetchMeta = async (
  client: MetadataClient,
  type: string,
  account: string,
  container: string,
  filePath: string
) => {
  const response = await client.getMeta(account, container, filePath);
  return response;
};

const updateDataSourceMeta = async (
  client: MetadataClient,
  account: string,
  container: string,
  filePath: string,
  meta: SigMFMetadata
) => {
  const response = await client.updateMeta(account, container, filePath, meta);
  return response;
};

export const useQueryDataSourceMetaPaths = (type: string, account: string, container: string, enabled = true) => {
  const metadataClient = MetadataClientFactory(type);
  return useQuery(
    ['datasource', type, account, container, 'meta', 'paths'],
    () => {
      return metadataClient.getDataSourceMetaPaths(account, container);
    },
    {
      enabled: enabled,
      staleTime: Infinity,
    }
  );
};

export const getMeta = (type: string, account: string, container: string, filePath: string, enabled = true) => {
  const metadataClient = MetadataClientFactory(type);
  return useQuery(
    ['datasource', type, account, container, filePath, 'meta'],
    () => {
      return fetchMeta(metadataClient, type, account, container, filePath);
    },
    {
      enabled: enabled,
      staleTime: Infinity,
    }
  );
};

export const useUpdateMeta = (meta: SigMFMetadata) => {
  let client = useQueryClient();
  if (!meta.getOrigin()) {
    throw new Error('Meta is missing origin');
  }
  const { type, account, container, file_path: filePath } = meta.getOrigin();
  const metadataClient = MetadataClientFactory(type);

  return useMutation({
    mutationFn: (newMeta: SigMFMetadata) => {
      return updateDataSourceMeta(metadataClient, account, container, filePath, newMeta);
    },
    onMutate: async () => {
      await client.cancelQueries(['datasource', type, account, container, filePath, 'meta']);
      const previousMeta = client.getQueryData(['datasource', type, account, container, filePath, 'meta']);
      client.setQueryData(['datasource', type, account, container, filePath, 'meta'], meta);
      return { previousMeta };
    },
    onError: (err, newMeta, context) => {
      console.error('onError', err);
      client.setQueryData(['datasource', type, account, container, filePath, 'meta'], context.previousMeta);
    },
  });
};

export const useGetMetadataFeatures = (type: string) => {
  const metadataClient = MetadataClientFactory(type);
  return metadataClient.features();
};

export const useMeta = (type: string, account: string, container: string, filePath: string) => {
  const metadataClient = MetadataClientFactory(type);
  return useQuery<SigMFMetadata>({
    queryKey: ['datasource', type, account, container, filePath, 'meta'],
    queryFn: () => {
      return metadataClient.getMeta(account, container, filePath);
    },
  });
};
