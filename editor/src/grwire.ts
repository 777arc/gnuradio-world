// GRWire Source: the editor half.
//
// Unlike the WebUSB radios there is no device permission to obtain and no
// USBDevice to re-acquire -- the runner's worker just opens a socket. What
// replaces it is a *reachability* problem, and it is worse, because the browser
// deliberately tells script nothing about why a WebSocket failed. So the editor
// probes before the run and turns the one bit it gets ("it did not open") into
// a specific message, using what it can check separately: whether the daemon's
// HTTPS endpoint answers at all.
//
// See docs/grwire.md.

import type { Inst } from './graph-model';

export const GRWIRE_ID = 'wasm_grwire_source';
export const GRWIRE_SERVER_DTYPE = 'grwire_server';
export const GRWIRE_DEVICE_DTYPE = 'grwire_device';

/** Saved servers, so a URL is typed once per machine. */
const SERVERS_KEY = 'gnuradio-world.grwire-servers';

/**
 * Access tokens, by `host:port`, kept in this browser and never in the .grc.
 *
 * The token is the only thing protecting a radio from any page the user
 * happens to visit -- their browser is on the same network as the daemon, so a
 * public site really can reach it. A `.grc` is the one file this project
 * encourages people to share, so it must not carry one: a flowgraph posted to a
 * forum would hand out the poster's radio.
 */
const TOKENS_KEY = 'gnuradio-world.grwire-tokens';

export interface GrWireDevice {
  args: string;
  driver: string;
  label: string;
  serial: string | null;
}

/** What one opened channel can do, as the daemon reports it. */
export interface GrWireChannelInfo {
  driver: string;
  gain_elements: string[];
  gain_range: { min: number; max: number } | null;
  antennas: string[];
  agc_available: boolean;
  bandwidth_range: { min: number; max: number } | null;
  formats: string[];
}

export interface GrWireHello {
  host: string;
  version: string;
  backends: string[];
}

export interface GrWireDeviceProbe {
  ok: boolean;
  info?: GrWireChannelInfo;
  problem?: string;
}

export interface GrWireProbe {
  ok: boolean;
  hello?: GrWireHello;
  devices?: GrWireDevice[];
  /** A message fit to show a user, when ok is false. */
  problem?: string;
  /** The https:// page to open so the certificate can be accepted. */
  trustUrl?: string;
}

function localGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function localSet(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private browsing */
  }
}

export function savedServers(): string[] {
  const raw = localGet(SERVERS_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(s => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberServer(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) return;
  const list = [trimmed, ...savedServers().filter(s => s !== trimmed)].slice(0, 8);
  localSet(SERVERS_KEY, JSON.stringify(list));
}

export function forgetServer(url: string): void {
  localSet(SERVERS_KEY, JSON.stringify(savedServers().filter(s => s !== url)));
}

/** `host:port` of a server URL, which is what a token belongs to. */
export function serverHost(url: string): string {
  try {
    return new URL(url.trim()).host;
  } catch {
    return '';
  }
}

/** Separate a pasted URL into the part that may be saved and the part that may not. */
export function splitToken(url: string): { url: string; token: string } {
  const trimmed = String(url ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { url: trimmed, token: '' };
  }
  const token = parsed.searchParams.get('token') ?? '';
  parsed.searchParams.delete('token');
  // Drop a now-empty '?' so the stored value is the clean URL the daemon
  // prints, not one with a dangling separator.
  const cleaned = parsed.toString().replace(/\?$/, '');
  return { url: cleaned, token };
}

function tokenStore(): Record<string, string> {
  const raw = localGet(TOKENS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function rememberToken(url: string, token: string): void {
  const host = serverHost(url);
  if (!host || !token) return;
  const store = tokenStore();
  store[host] = token;
  localSet(TOKENS_KEY, JSON.stringify(store));
}

export function forgetToken(url: string): void {
  const host = serverHost(url);
  if (!host) return;
  const store = tokenStore();
  delete store[host];
  localSet(TOKENS_KEY, JSON.stringify(store));
}

/** The token for this server: one embedded in the URL wins, else the saved one. */
export function tokenFor(url: string): string {
  const { token } = splitToken(url);
  if (token) return token;
  const host = serverHost(url);
  return host ? (tokenStore()[host] ?? '') : '';
}

/**
 * The URL with its token spliced back on, for actually connecting.
 *
 * This is what the Run path substitutes into the flowgraph handed to the
 * runner, the same way a local file's path is substituted -- so the token
 * exists in the URL bar of the runner frame and nowhere on disk.
 */
export function withToken(url: string): string {
  const { url: bare, token } = splitToken(url);
  const resolved = token || tokenFor(bare);
  if (!bare || !resolved) return bare;
  const separator = bare.includes('?') ? '&' : '?';
  return `${bare}${separator}token=${encodeURIComponent(resolved)}`;
}

/** Never show a token in the UI, in a log line, or in a bug report. */
export function redactToken(url: string): string {
  return url.replace(/([?&]token=)[^&]*/i, '$1***');
}

/**
 * What is wrong with this URL as written, or null.
 *
 * Only what is knowable without opening a socket: every issue raised on an
 * active block blocks the run, so reachability is deliberately not checked here.
 */
export function serverProblem(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return 'give the block the URL grwire printed when it started';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `"${redactToken(trimmed)}" is not a URL`;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return 'the server URL must start with wss:// (or ws:// for 127.0.0.1)';
  }
  // The constraint that shapes the whole design: a page served over https may
  // not open an insecure socket, except to loopback. Catch it here, where it can
  // be explained, rather than as an opaque failure inside the worker.
  if (
    parsed.protocol === 'ws:' &&
    typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    !isLoopback(parsed.hostname)
  ) {
    return (
      `this page is served over https, so it cannot open an insecure ws:// ` +
      `connection to ${parsed.hostname}. Use wss:// (restart grwire without ` +
      `--insecure, and accept its certificate once at ${trustUrlFor(trimmed)})`
    );
  }
  if (!tokenFor(trimmed)) {
    return (
      'no access token saved for this server in this browser -- paste the whole ' +
      'line grwire printed, including its ?token=..., and it will be kept here ' +
      'rather than in the flowgraph'
    );
  }
  return null;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' ||
    hostname === '::1';
}

/** The daemon's own page, where the certificate warning can be accepted. */
export function trustUrlFor(server: string): string {
  try {
    const parsed = new URL(server);
    return `https://${parsed.host}/`;
  } catch {
    return '';
  }
}

/**
 * Open a socket, complete the handshake and list the radios.
 *
 * Rejects rather than hangs: a daemon that accepts TCP but never speaks would
 * otherwise leave the Connect button spinning forever.
 */
export function probeServer(server: string, timeoutMs = 6000): Promise<GrWireProbe> {
  const problem = serverProblem(server);
  if (problem) return Promise.resolve({ ok: false, problem });

  return new Promise<GrWireProbe>(resolve => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(withToken(server), ['grwire.v1']);
    } catch (error) {
      resolve({ ok: false, problem: String((error as Error)?.message || error) });
      return;
    }

    let hello: GrWireHello | undefined;
    let settled = false;
    const finish = (result: GrWireProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({
        ok: false,
        problem: `${redactToken(server)} did not answer within ${timeoutMs / 1000}s`,
      }),
      timeoutMs,
    );

    socket.onopen = () => socket.send(JSON.stringify({ op: 'list' }));

    socket.onmessage = event => {
      if (typeof event.data !== 'string') return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.ev === 'hello') {
        hello = {
          host: String(message.host ?? ''),
          version: String(message.version ?? ''),
          backends: Array.isArray(message.backends) ? (message.backends as string[]) : [],
        };
      }
      if (message.ev === 'devices') {
        finish({ ok: true, hello, devices: (message.devices as GrWireDevice[]) ?? [] });
      }
      if (message.ev === 'error') {
        finish({ ok: false, problem: `${message.code}: ${message.message}` });
      }
    };

    // A browser will not say whether this was DNS, a refused connection, or an
    // untrusted certificate -- by design, to stop pages port-scanning a LAN. So
    // name the likeliest cause instead of guessing wrong.
    socket.onerror = () => finish(unreachable(server));
    socket.onclose = event => {
      if (settled) return;
      if (event.code === 1008 || event.code === 1002) {
        finish({ ok: false, problem: 'the daemon refused the token or this origin' });
        return;
      }
      finish(unreachable(server));
    };
  });
}

function unreachable(server: string): GrWireProbe {
  const secure = server.startsWith('wss://');
  const trustUrl = trustUrlFor(server);
  return {
    ok: false,
    trustUrl: secure ? trustUrl : undefined,
    problem: secure
      ? `could not reach ${redactToken(server)}. If grwire is running there, this ` +
        `browser has probably not accepted its certificate yet -- open ${trustUrl} ` +
        `once, accept the warning, then try again.`
      : `could not reach ${redactToken(server)} -- check that grwire is running and ` +
        `that the address and token are right.`,
  };
}

/**
 * Open one radio and report what it can do.
 *
 * Separate from `probeServer` because capabilities are per *device*: the gain
 * stages and whether there is an AGC at all are things only `open` reveals.
 * This briefly claims the radio, so it is only ever done on an explicit click.
 */
export function probeDevice(
  server: string,
  device: string,
  timeoutMs = 8000,
): Promise<GrWireDeviceProbe> {
  const problem = serverProblem(server);
  if (problem) return Promise.resolve({ ok: false, problem });

  return new Promise<GrWireDeviceProbe>(resolve => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(withToken(server), ['grwire.v1']);
    } catch (error) {
      resolve({ ok: false, problem: String((error as Error)?.message || error) });
      return;
    }
    let settled = false;
    const finish = (result: GrWireDeviceProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, problem: `${redactToken(server)} did not answer in time` }),
      timeoutMs,
    );

    socket.onmessage = event => {
      if (typeof event.data !== 'string') return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.ev === 'hello') {
        socket.send(JSON.stringify({ op: 'open', device, direction: 'rx', channel: 0 }));
      }
      if (message.ev === 'opened') {
        finish({ ok: true, info: message.info as GrWireChannelInfo });
      }
      if (message.ev === 'error') {
        finish({ ok: false, problem: `${message.code}: ${message.message}` });
      }
    };
    socket.onerror = () => finish({ ok: false, problem: unreachable(server).problem });
    socket.onclose = () => finish({ ok: false, problem: unreachable(server).problem });
  });
}

/** The GRWire blocks that will actually run. */
export function activeGrWireBlocks(insts: Inst[]): Inst[] {
  return insts.filter(inst => inst.id === GRWIRE_ID && inst.enabled && !inst.bypassed);
}

/**
 * Run-click preparation: fail the run with something specific rather than
 * letting the runner start and die inside a worker.
 *
 * Must be called while the Run click's activation is still live, because the
 * remedy for an untrusted certificate is opening a tab.
 */
export interface GrWirePreparation {
  /** A message that should stop the run, or null. */
  problem: string | null;
  /**
   * Per block name, the server URL with its token spliced back on.
   *
   * The Run path substitutes these into the flowgraph it hands the runner, the
   * same way a local file's path is substituted. The token therefore exists in
   * the runner frame's URL and never in the document that gets saved.
   */
  overrides: Map<string, string>;
}

export async function prepareGrWire(
  insts: Inst[],
  openTrustPage: (url: string) => void,
): Promise<GrWirePreparation> {
  const overrides = new Map<string, string>();
  const blocks = activeGrWireBlocks(insts);
  if (!blocks.length) return { problem: null, overrides };

  const probed = new Map<string, GrWireProbe>();
  for (const block of blocks) {
    const server = String(block.params?.server ?? '').trim();

    // A flowgraph written before the token moved out of the .grc, or one
    // shared by someone else, may still carry one. Honour it for this run and
    // keep it for next time, so the URL saved from here on is clean.
    const { url: bare, token } = splitToken(server);
    if (token) rememberToken(bare, token);

    let result = probed.get(bare);
    if (!result) {
      result = await probeServer(bare);
      probed.set(bare, result);
    }
    if (!result.ok) {
      if (result.trustUrl) openTrustPage(result.trustUrl);
      return { problem: `"${block.name}": ${result.problem}`, overrides };
    }
    rememberServer(bare);
    overrides.set(block.name, withToken(bare));
  }
  return { problem: null, overrides };
}
