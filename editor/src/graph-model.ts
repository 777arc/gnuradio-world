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
