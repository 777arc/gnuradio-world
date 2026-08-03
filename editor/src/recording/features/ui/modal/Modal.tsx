import { useRef } from 'react';
import { useOnClickOutside } from 'usehooks-ts';

interface ModalProps {
  heading: string;
  setShowModal: any;
  children: any;
  classList?: string;
}
export const ModalDialog = ({ heading, setShowModal, children, classList }: ModalProps) => {
  const ref = useRef(null);
  useOnClickOutside(ref, () => {
    setShowModal(false);
  });

  return (
    <dialog aria-labelledby={heading.replace(/ /g, '')} className="modal modal-open w-full h-full">
      {/* border + radius match the editor's own dialogs (.dlg in editor/index.html) */}
      <div className={`modal-box rounded-lg border border-secondary ${classList}`}>
        <h3 id={heading.replace(/ /g, '')} className="font-bold text-base-content">
          {heading}
        </h3>
        <button
          aria-label={'Close'}
          className="absolute right-2 top-2 border-0 bg-transparent text-muted hover:text-base-content font-bold"
          onClick={() => {
            setShowModal(false);
          }}
        >
          ✕
        </button>
        {children}
      </div>
    </dialog>
  );
};
