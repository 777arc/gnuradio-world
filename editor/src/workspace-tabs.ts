export type WorkspaceTab = 'editor' | 'qtgui' | string;

export interface WorkspaceTabEntry {
  id: WorkspaceTab;
  button: HTMLButtonElement;
  panel: HTMLElement;
  container?: HTMLElement;
}

export interface WorkspaceTabDeps {
  editorPane: HTMLElement;
  runnerPane: HTMLElement;
  isRecordingTab(id: WorkspaceTab): boolean;
  recordingKey(id: WorkspaceTab): string;
  openRecording(key: string): Promise<void>;
  closeRecording(key: string): boolean;
}

export class WorkspaceTabsController {
  readonly entries: WorkspaceTabEntry[];
  active: WorkspaceTab = 'editor';

  constructor(private readonly deps: WorkspaceTabDeps,
              editorTab: WorkspaceTabEntry, runnerTab: WorkspaceTabEntry) {
    this.entries = [editorTab, runnerTab];
    this.entries.forEach(entry => this.wire(entry));
  }

  activate(tab: WorkspaceTab): void {
    if (!this.entries.some(entry => entry.id === tab)) tab = 'editor';
    this.active = tab;
    this.deps.editorPane.hidden = tab !== 'editor';
    this.deps.runnerPane.hidden = tab !== 'qtgui';
    for (const entry of this.entries) {
      const active = entry.id === tab;
      entry.button.classList.toggle('active', active);
      entry.button.setAttribute('aria-selected', String(active));
      entry.button.tabIndex = active ? 0 : -1;
      if (this.deps.isRecordingTab(entry.id)) entry.panel.classList.toggle('active', active);
    }
    if (this.deps.isRecordingTab(tab))
      void this.deps.openRecording(this.deps.recordingKey(tab));
  }

  wire(entry: WorkspaceTabEntry): void {
    entry.button.addEventListener('click', () => this.activate(entry.id));
    entry.button.addEventListener('keydown', event => {
      const index = this.entries.indexOf(entry);
      if (index < 0) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!this.deps.isRecordingTab(entry.id) ||
            !this.deps.closeRecording(this.deps.recordingKey(entry.id))) return;
        event.preventDefault();
        return;
      }
      let next = index;
      if (event.key === 'ArrowLeft') next = (index + this.entries.length - 1) % this.entries.length;
      else if (event.key === 'ArrowRight') next = (index + 1) % this.entries.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = this.entries.length - 1;
      else return;
      const target = this.entries[next];
      this.activate(target.id);
      target.button.focus();
      event.preventDefault();
    });
  }
}

export function tabContainer(entry: WorkspaceTabEntry): HTMLElement {
  return entry.container || entry.button;
}
