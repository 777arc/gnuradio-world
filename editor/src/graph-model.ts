export interface Inst {
  uid: string;
  id: string;
  name: string;
  x: number;
  y: number;
  params: Record<string, any>;
  enabled: boolean;
  rotation: number;
  bypassed: boolean;
  // Unknown blocks retain their interface per instance, reconstructed from the
  // file's connections. Keep it in history/clipboard snapshots, not the palette.
  missing?: { in: string[]; out: string[]; states: Record<string, any> };
  // Browser File objects cannot be serialized into .grc. History snapshots
  // retain this opaque token while the actual File stays in a session map.
  localFileToken?: string;
}

export interface Conn {
  from: string;
  fp: number;
  to: string;
  tp: number;
}

export interface ValidationIssue {
  uid: string;
  field: string;
  message: string;
  blocking: boolean;
  connection?: Conn;
}

export interface GraphSnapshot {
  insts: Inst[];
  conns: Conn[];
  counter: number;
}
