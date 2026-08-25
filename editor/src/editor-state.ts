import type { Conn, Inst } from './graph-model';

/**
 * Mutable state for the flowgraph being edited.
 *
 * Browser chrome, canvas gestures, training, and runner lifecycle deliberately
 * stay outside this object. Feature controllers receive this focused object
 * instead of importing mutable bindings from the application entry point.
 */
export class EditorGraphState {
  insts: Inst[] = [];
  conns: Conn[] = [];
  selected: string | null = null;
  selectedBlocks = new Set<string>();
  selectedConnection: Conn | null = null;
  counter = 0;

  clearSelection(): void {
    this.selected = null;
    this.selectedBlocks.clear();
    this.selectedConnection = null;
  }
}
