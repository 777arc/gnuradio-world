// A grwire.v1 daemon with no radio and no Rust in it.
//
// The smoke suite must run on a machine with no cargo, no SoapySDR and nothing
// plugged in, so the browser half of GRWire is tested against this instead of
// the real daemon: same handshake, same JSON control plane, same binary frame
// header. What it cannot cover is the daemon itself -- that has its own Rust
// tests and `grwire/tools/probe.mjs`.
//
// The WebSocket framing is hand-rolled to keep the test suite free of a
// dependency it would otherwise need only here. Only what the protocol uses is
// implemented: text and binary frames from the server, masked text frames from
// the client, close, and ping.

import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MAGIC = 0x31575247; // 'GRW1'
const HEADER_BYTES = 32;
const FRAME_RX_IQ = 1;
const FORMAT_CODES = { ci8: 1, ci16: 2, cf32: 3 };
const FORMAT_BYTES = { ci8: 2, ci16: 4, cf32: 8 };

/** Encode one server->client frame. Server frames are never masked. */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

/** Pull whole frames out of a running buffer; returns [frames, remainder]. */
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let mask = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, payload });
    offset = cursor + length;
  }
  return [frames, buffer.subarray(offset)];
}

/**
 * Attach a mock daemon to an existing http.Server.
 *
 * `path` is the URL the fixture points at. Options let a test provoke the
 * failure modes that matter: refusing the connection, stalling, or dropping.
 */
export function attachGrWireMock(server, { path = '/grwire', tone = 250000 } = {}) {
  const state = {
    connections: 0,
    started: 0,
    lastConfigure: null,
    acks: 0,
    /** Every `gains` object received, so a test can see what reached the radio. */
    gainsSeen: [],
  };

  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }

    const key = request.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const offered = String(request.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((s) => s.trim());
    const protocol = offered.includes('grwire.v1') ? 'grwire.v1' : null;

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') +
        '\r\n'
    );
    state.connections += 1;

    let pending = Buffer.alloc(0);
    let timer = null;
    let seq = 0;
    let sampleIndex = 0;
    let phase = 0;
    let config = { rate: 1000000, decim: 1, format: 'ci8', freq: 100e6, offset: 0 };

    const sendText = (message) =>
      socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(message))));

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    socket.on('close', stop);
    socket.on('error', stop);

    sendText({
      ev: 'hello',
      protocol: 'grwire.v1',
      version: '0.1.0-mock',
      host: 'grwire-mock',
      backends: ['fake'],
    });

    const startStreaming = () => {
      stop();
      const outRate = config.rate;
      const bytes = FORMAT_BYTES[config.format] || 2;
      // ~15 ms of samples per frame, as the real daemon does.
      const perFrame = Math.max(1, Math.round((outRate * 15) / 1000));
      const step = (2 * Math.PI * tone) / outRate;

      timer = setInterval(() => {
        if (socket.destroyed) return stop();
        const payload = Buffer.alloc(HEADER_BYTES + perFrame * bytes);
        payload.writeUInt32LE(MAGIC, 0);
        payload.writeUInt8(FRAME_RX_IQ, 4);
        payload.writeUInt8(FORMAT_CODES[config.format] || 1, 5);
        payload.writeUInt16LE(0, 6);
        payload.writeUInt32LE(1, 8);
        payload.writeUInt32LE(perFrame, 12);
        payload.writeBigUInt64LE(BigInt(seq), 16);
        payload.writeBigUInt64LE(BigInt(sampleIndex), 24);
        for (let i = 0; i < perFrame; i += 1) {
          const at = HEADER_BYTES + i * bytes;
          const re = Math.cos(phase);
          const im = Math.sin(phase);
          phase += step;
          if (config.format === 'cf32') {
            payload.writeFloatLE(re * 0.5, at);
            payload.writeFloatLE(im * 0.5, at + 4);
          } else if (config.format === 'ci16') {
            payload.writeInt16LE(Math.round(re * 16000), at);
            payload.writeInt16LE(Math.round(im * 16000), at + 2);
          } else {
            payload.writeInt8(Math.round(re * 63), at);
            payload.writeInt8(Math.round(im * 63), at + 1);
          }
        }
        seq += 1;
        sampleIndex += perFrame;
        socket.write(encodeFrame(0x2, payload));

        if (seq % 33 === 0) {
          sendText({
            ev: 'stats',
            uptime_s: (seq * perFrame) / outRate,
            out_rate: outRate,
            measured_rate: outRate,
            rate_suspect: false,
            samples_sent: sampleIndex,
            frames_sent: seq,
            bytes_sent: seq * payload.length,
            dev_overruns: 0,
            host_drops: 0,
            net_drops: 0,
            client_drops: 0,
            dropped_samples: 0,
            in_flight: 0,
            client_ring_used: 0,
          });
        }
      }, 15);
    };

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const [frames, rest] = decodeFrames(pending);
      pending = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          stop();
          socket.end();
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode !== 0x1) continue;

        let message;
        try {
          message = JSON.parse(frame.payload.toString());
        } catch {
          continue;
        }

        switch (message.op) {
          case 'list':
            sendText({
              ev: 'devices',
              devices: [
                { args: 'fake', driver: 'fake', label: 'Mock radio', serial: null },
              ],
            });
            break;
          case 'open':
            sendText({
              ev: 'opened',
              device: message.device,
              info: {
                driver: 'fake',
                channel: 0,
                full_duplex: false,
                freq_range: { min: 0, max: 6e9, values: [], intervals: [] },
                rate_range: { min: 8000, max: 20e6, values: [], intervals: [] },
                gain_range: { min: 0, max: 50, values: [], intervals: [] },
                // Three, named like a HackRF's, so the block's positional
                // stage1..3 slots have something to map onto.
                gain_elements: ['LNA', 'AMP', 'VGA'],
                antennas: ['RX'],
                bandwidth_range: null,
                agc_available: true,
                formats: ['ci8', 'ci16', 'cf32'],
              },
            });
            break;
          case 'configure': {
            state.lastConfigure = message;
            if (message.gains) state.gainsSeen.push(message.gains);
            if (Number.isFinite(message.rate)) config.rate = message.rate;
            if (Number.isFinite(message.decim)) config.decim = message.decim;
            if (message.format) config.format = message.format;
            if (Number.isFinite(message.freq)) config.freq = message.freq;
            if (Number.isFinite(message.offset)) config.offset = message.offset;
            sendText({
              ev: 'config',
              epoch: 1,
              applied: {
                hw_rate: config.rate * config.decim,
                decim: config.decim,
                out_rate: config.rate,
                freq: config.freq,
                offset: config.offset,
                gain: 30,
                agc: false,
                antenna: 'RX',
                bandwidth: null,
                format: config.format,
                frame_samples: Math.max(1, Math.round((config.rate * 15) / 1000)),
                warnings: [],
              },
            });
            break;
          }
          case 'start':
            state.started += 1;
            startStreaming();
            break;
          case 'stop':
            stop();
            break;
          case 'flow':
            state.acks += 1;
            break;
          case 'ping':
            sendText({ ev: 'pong', t: message.t });
            break;
          default:
            break;
        }
      }
    });
  });

  return state;
}
