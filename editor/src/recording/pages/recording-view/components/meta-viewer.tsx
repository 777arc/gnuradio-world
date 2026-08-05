import { SigMFMetadata } from '@/utils/sigmfMetadata';
import { unitPrefixHz } from '@/utils/rf-functions';

export interface MetaViewerProps {
  meta: SigMFMetadata;
}

export const MetaViewer = ({ meta }: MetaViewerProps) => {
  if (!meta) return <></>;
  return (
    /* Wraps rather than overflowing: four label/value pairs do not fit one line
       on a phone, and the summary is the widest thing under the plot. */
    <div className="flex flex-wrap justify-evenly gap-x-4 rounded-md border border-base-300 bg-base-200 p-2">
      <div className="flex">
        <div className="text-muted mr-2">data type:</div>
        <div className="text-base-content">{meta.getDataType()}</div>
      </div>
      <div className="flex">
        <div className="text-muted mr-2">sample rate:</div>
        <div className="text-base-content">
          {unitPrefixHz(meta.getSampleRate()).freq} {unitPrefixHz(meta.getSampleRate()).unit}
        </div>
      </div>
      <div className="flex">
        <div className="text-muted mr-2">file name:</div>
        <div className="text-base-content">{meta.getFileName()}</div>
      </div>
      <div className="flex">
        <div className="text-muted mr-2">description:</div>
        <div className="text-base-content">{meta.getDescription()}</div>
      </div>
    </div>
  );
};

export default MetaViewer;
