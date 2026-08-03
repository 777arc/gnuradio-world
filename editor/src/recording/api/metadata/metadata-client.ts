import { SigMFMetadata } from '@/utils/sigmfMetadata';

export interface MetadataClient {
  getMeta(account: string, container: string, filePath: string): Promise<SigMFMetadata>;
}
