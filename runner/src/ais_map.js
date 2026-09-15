// Browser-native map for wasm_ais_map_sink. The GNU Radio block forwards each
// packet's bytes -- a deframed AIS payload or an !AIVDM sentence -- in compact
// JSON batches; this file decodes the AIS messages, owns vessel state, MapLibre,
// interaction, rendering, and semantic GUI observation. Same shape as
// adsb_map.js, with a vessel decoder in place of the aircraft record parser.
(() => {
  'use strict';

  const MAX_VESSELS = 2048;
  const MAX_TRAIL_POINTS = 240;
  const FRAGMENT_TIMEOUT_MS = 30000;
  const UI_FONT = '16px system-ui, sans-serif';
  const UI_MONO_FONT = '15px ui-monospace, SFMono-Regular, Menlo, monospace';
  const MAPLIBRE_DIRECTORY = 'maplibre-6.8.0';
  const STYLE_URLS = {
    light: 'https://tiles.openfreemap.org/styles/positron',
    dark: 'https://tiles.openfreemap.org/styles/dark',
  };

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const numeric = value => value !== null && value !== undefined && value !== '' &&
    Number.isFinite(Number(value)) ? Number(value) : null;
  const radians = degrees => degrees * Math.PI / 180;
  const degrees = radiansValue => radiansValue * 180 / Math.PI;

  // ---------------------------------------------------------------------------
  // AIS decoding (ITU-R M.1371 / the AIVDM field layout).
  // ---------------------------------------------------------------------------

  const SIX_BIT_ASCII =
    '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?';

  const NAV_STATUS = [
    'Under way using engine', 'At anchor', 'Not under command',
    'Restricted manoeuvrability', 'Constrained by draught', 'Moored', 'Aground',
    'Engaged in fishing', 'Under way sailing', 'Reserved (HSC)', 'Reserved (WIG)',
    'Power-driven towing astern', 'Power-driven pushing ahead', 'Reserved',
    'AIS-SART active', 'Undefined',
  ];

  const AID_TYPES = [
    'Unspecified', 'Reference point', 'RACON', 'Fixed structure off shore',
    'Emergency wreck mark', 'Light, without sectors', 'Light, with sectors',
    'Leading light front', 'Leading light rear', 'Beacon, cardinal N',
    'Beacon, cardinal E', 'Beacon, cardinal S', 'Beacon, cardinal W',
    'Beacon, port hand', 'Beacon, starboard hand', 'Beacon, preferred channel port',
    'Beacon, preferred channel starboard', 'Beacon, isolated danger',
    'Beacon, safe water', 'Beacon, special mark', 'Cardinal mark N',
    'Cardinal mark E', 'Cardinal mark S', 'Cardinal mark W', 'Port hand mark',
    'Starboard hand mark', 'Preferred channel port', 'Preferred channel starboard',
    'Isolated danger', 'Safe water', 'Special mark', 'Light vessel / LANBY',
  ];

  // The 6-bit ASCII "armor" of an AIVDM payload, each character six bits MSB
  // first, less the sentence's fill bits.
  function bitsFromArmor(payload, fill = 0) {
    const bits = [];
    for (const character of String(payload)) {
      let value = character.charCodeAt(0) - 48;
      if (value > 40) value -= 8;
      if (value < 0 || value > 63) return null;
      for (let bit = 5; bit >= 0; bit--) bits.push((value >> bit) & 1);
    }
    const drop = clamp(Math.floor(numeric(fill) ?? 0), 0, 5);
    return drop ? bits.slice(0, bits.length - drop) : bits;
  }

  // A deframed packet's bytes, MSB first -- the order AIS PDU to NMEA reads
  // them in, so both inputs decode identically.
  function bitsFromHex(hex) {
    const text = String(hex || '').trim();
    if (!/^[0-9a-fA-F]*$/.test(text) || text.length % 2) return null;
    const bits = [];
    for (let i = 0; i < text.length; i += 2) {
      const byte = parseInt(text.slice(i, i + 2), 16);
      for (let bit = 7; bit >= 0; bit--) bits.push((byte >> bit) & 1);
    }
    return bits;
  }

  function unsignedField(bits, start, length) {
    if (start + length > bits.length) return null;
    let value = 0;
    for (let i = start; i < start + length; i++) value = value * 2 + bits[i];
    return value;
  }

  function signedField(bits, start, length) {
    const value = unsignedField(bits, start, length);
    if (value == null) return null;
    return bits[start] ? value - 2 ** length : value;
  }

  function textField(bits, start, length) {
    let text = '';
    for (let offset = start; offset + 6 <= Math.min(bits.length, start + length); offset += 6) {
      const code = unsignedField(bits, offset, 6);
      if (code === 0) break;
      text += SIX_BIT_ASCII[code];
    }
    return text.replace(/[\s@]+$/, '').trim();
  }

  const unavailable = (value, sentinel) => value == null || value === sentinel ? null : value;

  function coordinates(bits, longitudeStart, latitudeStart, scale = 600000) {
    const longitudeBits = scale === 600 ? 18 : 28;
    const latitudeBits = scale === 600 ? 17 : 27;
    const longitude = signedField(bits, longitudeStart, longitudeBits);
    const latitude = signedField(bits, latitudeStart, latitudeBits);
    const result = {};
    if (longitude != null && latitude != null && longitude !== 181 * scale &&
      latitude !== 91 * scale) {
      const lon = longitude / scale;
      const lat = latitude / scale;
      if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
        result.longitude = lon;
        result.latitude = lat;
      }
    }
    return result;
  }

  function dimensions(bits, start) {
    const bow = unsignedField(bits, start, 9);
    const stern = unsignedField(bits, start + 9, 9);
    const port = unsignedField(bits, start + 18, 6);
    const starboard = unsignedField(bits, start + 24, 6);
    if (bow == null || stern == null || port == null || starboard == null) return {};
    const result = {};
    if (bow + stern > 0) result.length = bow + stern;
    if (port + starboard > 0) result.beam = port + starboard;
    return result;
  }

  function rateOfTurn(raw) {
    if (raw == null || raw === -128) return null;
    if (raw === 127) return Infinity;      // turning right, more than 5°/30 s
    if (raw === -127) return -Infinity;    // turning left, likewise
    const value = (raw / 4.733) ** 2;
    return raw < 0 ? -value : value;
  }

  function speedOverGround(raw, sentinel = 1023) {
    const value = unavailable(raw, sentinel);
    return value == null ? null : value / 10;
  }

  function courseOverGround(raw) {
    const value = unavailable(raw, 3600);
    return value == null ? null : value / 10;
  }

  // One AIS message from its bit array. Returns null for anything too short
  // to carry a type and MMSI; unknown types still return those two.
  function decodeAisPayload(bits) {
    if (!Array.isArray(bits) || bits.length < 38) return null;
    const type = unsignedField(bits, 0, 6);
    const mmsi = unsignedField(bits, 8, 30);
    const message = { type, mmsi };
    switch (type) {
    case 1: case 2: case 3:
      Object.assign(message, {
        nav_status: unsignedField(bits, 38, 4),
        rot: rateOfTurn(signedField(bits, 42, 8)),
        sog: speedOverGround(unsignedField(bits, 50, 10)),
        ...coordinates(bits, 61, 89),
        cog: courseOverGround(unsignedField(bits, 116, 12)),
        heading: unavailable(unsignedField(bits, 128, 9), 511),
      });
      break;
    case 4: case 11:
      Object.assign(message, { base_station: true, ...coordinates(bits, 79, 107) });
      break;
    case 5:
      Object.assign(message, {
        imo: unavailable(unsignedField(bits, 40, 30), 0),
        callsign: textField(bits, 70, 42),
        name: textField(bits, 112, 120),
        ship_type: unsignedField(bits, 232, 8),
        ...dimensions(bits, 240),
        destination: textField(bits, 302, 120),
      });
      {
        const draught = unsignedField(bits, 294, 8);
        if (draught) message.draught = draught / 10;
      }
      break;
    case 9:
      Object.assign(message, {
        sar_aircraft: true,
        altitude: unavailable(unsignedField(bits, 38, 12), 4095),
        sog: unavailable(unsignedField(bits, 50, 10), 1023),
        ...coordinates(bits, 61, 89),
        cog: courseOverGround(unsignedField(bits, 116, 12)),
      });
      break;
    case 18:
      Object.assign(message, {
        class_b: true,
        sog: speedOverGround(unsignedField(bits, 46, 10)),
        ...coordinates(bits, 57, 85),
        cog: courseOverGround(unsignedField(bits, 112, 12)),
        heading: unavailable(unsignedField(bits, 124, 9), 511),
      });
      break;
    case 19:
      Object.assign(message, {
        class_b: true,
        sog: speedOverGround(unsignedField(bits, 46, 10)),
        ...coordinates(bits, 57, 85),
        cog: courseOverGround(unsignedField(bits, 112, 12)),
        heading: unavailable(unsignedField(bits, 124, 9), 511),
        name: textField(bits, 143, 120),
        ship_type: unsignedField(bits, 263, 8),
        ...dimensions(bits, 271),
      });
      break;
    case 21:
      Object.assign(message, {
        aid_to_navigation: true,
        aid_type: unsignedField(bits, 38, 5),
        name: textField(bits, 43, 120),
        ...coordinates(bits, 164, 192),
        ...dimensions(bits, 219),
      });
      if (bits.length > 272) {
        const extension = textField(bits, 272, bits.length - 272);
        if (extension) message.name = `${message.name} ${extension}`.trim();
      }
      break;
    case 24: {
      const part = unsignedField(bits, 38, 2);
      message.class_b = true;
      if (part === 0) message.name = textField(bits, 40, 120);
      else if (part === 1) Object.assign(message, {
        ship_type: unsignedField(bits, 40, 8),
        callsign: textField(bits, 90, 42),
        ...dimensions(bits, 132),
      });
      break;
    }
    case 27:
      Object.assign(message, {
        nav_status: unsignedField(bits, 40, 4),
        ...coordinates(bits, 44, 62, 600),
        sog: unavailable(unsignedField(bits, 79, 6), 63),
        cog: unavailable(unsignedField(bits, 85, 9), 511),
      });
      break;
    default:
      break;
    }
    // Empty text fields mean "not yet reported", never "cleared".
    for (const key of ['name', 'callsign', 'destination'])
      if (key in message && !message[key]) delete message[key];
    return message;
  }

  // "!AIVDM,<count>,<index>,<sequence>,<channel>,<payload>,<fill>*<checksum>".
  // Returns the fields, or null when the sentence is malformed or its checksum
  // does not match.
  function parseNmeaSentence(sentence) {
    const text = String(sentence || '').trim();
    const match = /^([!$])(AIVD[MO]),(\d),(\d),(\d?),([AB12]?),([^,*]*),(\d)\*([0-9A-Fa-f]{2})$/
      .exec(text);
    if (!match) return null;
    let checksum = 0;
    for (let i = 1; i < text.length && text[i] !== '*'; i++)
      checksum ^= text.charCodeAt(i);
    if (checksum !== parseInt(match[9], 16)) return null;
    return {
      count: Number(match[3]), index: Number(match[4]), sequence: match[5],
      channel: match[6], payload: match[7], fill: Number(match[8]),
    };
  }

  // Multi-sentence messages (type 5 is two) arrive one fragment at a time;
  // this holds the partial ones by sequence id and channel until complete.
  class SentenceAssembler {
    constructor() { this.partial = new Map(); }

    // Returns the complete message's bits, or null while fragments are missing.
    push(sentence, now = Date.now()) {
      const fields = parseNmeaSentence(sentence);
      if (!fields) return null;
      if (fields.count <= 1) return bitsFromArmor(fields.payload, fields.fill);
      for (const [key, entry] of this.partial)
        if (now - entry.created > FRAGMENT_TIMEOUT_MS) this.partial.delete(key);
      const key = `${fields.sequence}|${fields.channel}`;
      const entry = this.partial.get(key) || { created: now, parts: [], count: fields.count };
      if (entry.count !== fields.count) entry.parts.length = 0;
      entry.parts[fields.index - 1] = fields;
      this.partial.set(key, entry);
      for (let i = 0; i < fields.count; i++) if (!entry.parts[i]) return null;
      this.partial.delete(key);
      const payload = entry.parts.map(part => part.payload).join('');
      return bitsFromArmor(payload, entry.parts[fields.count - 1].fill);
    }
  }

  // ---------------------------------------------------------------------------
  // Presentation helpers.
  // ---------------------------------------------------------------------------

  function formatMmsi(value) {
    const mmsi = numeric(value);
    return mmsi == null ? '' : String(Math.floor(mmsi)).padStart(9, '0');
  }

  function shipTypeText(type) {
    const value = numeric(type);
    if (value == null || value === 0) return 'Unknown';
    if (value >= 20 && value <= 29) return 'Wing in ground';
    const named = {
      30: 'Fishing', 31: 'Towing', 32: 'Towing, large', 33: 'Dredging / underwater ops',
      34: 'Diving ops', 35: 'Military ops', 36: 'Sailing', 37: 'Pleasure craft',
      50: 'Pilot vessel', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender',
      54: 'Anti-pollution', 55: 'Law enforcement', 58: 'Medical transport',
      59: 'Noncombatant ship',
    };
    if (named[value]) return named[value];
    const family = { 4: 'High-speed craft', 6: 'Passenger', 7: 'Cargo', 8: 'Tanker', 9: 'Other' }
      [Math.floor(value / 10)];
    if (!family) return `Reserved (${value})`;
    const hazard = value % 10;
    return hazard >= 1 && hazard <= 4 && value >= 60
      ? `${family}, hazardous cat. ${'ABCD'[hazard - 1]}` : family;
  }

  function vesselClass(vessel) {
    if (vessel.kind === 'base' || vessel.kind === 'aton' || vessel.kind === 'sar')
      return vessel.kind;
    const type = numeric(vessel.ship_type);
    if (type == null || type === 0) return 'unknown';
    if (type === 30) return 'fishing';
    if (type === 36 || type === 37) return 'pleasure';
    if (type === 31 || type === 32 || (type >= 50 && type <= 59)) return 'service';
    if ((type >= 20 && type <= 29) || (type >= 40 && type <= 49)) return 'hsc';
    if (type >= 33 && type <= 35) return 'special';
    if (type >= 60 && type <= 69) return 'passenger';
    if (type >= 70 && type <= 79) return 'cargo';
    if (type >= 80 && type <= 89) return 'tanker';
    return 'other';
  }

  const CLASS_COLORS = {
    cargo: '#67e8a5', tanker: '#ff7b72', passenger: '#67b8ff', fishing: '#ffb347',
    pleasure: '#d68cff', service: '#5ee0e8', hsc: '#ffe066', special: '#c8d2dc',
    other: '#b9c6d4', unknown: '#aab7c7', base: '#ffffff', aton: '#ffd700',
    sar: '#ff79c6',
  };

  function vesselColor(vessel) {
    return CLASS_COLORS[vesselClass(vessel)] || CLASS_COLORS.unknown;
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const values = [lat1, lon1, lat2, lon2].map(numeric);
    if (values.some(value => value == null)) return null;
    const [aLat, aLon, bLat, bLon] = values.map(radians);
    const dLat = bLat - aLat;
    const dLon = bLon - aLon;
    const term = Math.sin(dLat / 2) ** 2 +
      Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLon / 2) ** 2;
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(term), Math.sqrt(1 - term));
  }

  function bearingDegrees(lat1, lon1, lat2, lon2) {
    const values = [lat1, lon1, lat2, lon2].map(numeric);
    if (values.some(value => value == null)) return null;
    const [aLat, aLon, bLat, bLon] = values.map(radians);
    const y = Math.sin(bLon - aLon) * Math.cos(bLat);
    const x = Math.cos(aLat) * Math.sin(bLat) -
      Math.sin(aLat) * Math.cos(bLat) * Math.cos(bLon - aLon);
    return (degrees(Math.atan2(y, x)) + 360) % 360;
  }

  function destinationPoint(latitude, longitude, bearing, distanceKm) {
    const angular = distanceKm / 6371.0088;
    const lat1 = radians(latitude);
    const lon1 = radians(longitude);
    const angle = radians(bearing);
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(angle));
    const lon2 = lon1 + Math.atan2(Math.sin(angle) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
    return [((degrees(lon2) + 540) % 360) - 180, degrees(lat2)];
  }

  function formatAge(milliseconds) {
    const seconds = Math.max(0, milliseconds / 1000);
    if (seconds < 10) return `${seconds.toFixed(1)} s`;
    if (seconds < 120) return `${Math.round(seconds)} s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }

  function localStyle(dark = true) {
    return {
      version: 8,
      name: 'GNU Radio World offline map',
      sources: {},
      layers: [{
        id: 'gr-ais-background', type: 'background',
        paint: { 'background-color': dark ? '#07121f' : '#dce8ef' },
      }],
    };
  }

  function graticuleGeoJson() {
    const features = [];
    for (let longitude = -180; longitude <= 180; longitude += 30) {
      const coordinates = [];
      for (let latitude = -80; latitude <= 80; latitude += 2)
        coordinates.push([longitude, latitude]);
      features.push({ type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates } });
    }
    for (let latitude = -60; latitude <= 60; latitude += 20) {
      const coordinates = [];
      for (let longitude = -180; longitude <= 180; longitude += 3)
        coordinates.push([longitude, latitude]);
      features.push({ type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates } });
    }
    return { type: 'FeatureCollection', features };
  }

  function emptyFeatures() {
    return { type: 'FeatureCollection', features: [] };
  }

  function makeButton(label, action, title = label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.action = action;
    button.title = title;
    Object.assign(button.style, {
      minHeight: '28px', padding: '3px 8px', border: '1px solid #38516c',
      borderRadius: '4px', background: '#12243a', color: '#dce9f7',
      cursor: 'pointer', font: UI_FONT, whiteSpace: 'nowrap',
    });
    return button;
  }

  // The ADS-B map ships the same MapLibre; share its stylesheet load when it is
  // on the page so two maps do not append two <link>s.
  let mapLibreStylePromise = null;
  function loadMapLibreStyle() {
    const shared = globalThis.__grAdsbMapInternals?.loadMapLibreStyle;
    if (shared) return shared();
    if (mapLibreStylePromise) return mapLibreStylePromise;
    const styleUrl = new URL(`${MAPLIBRE_DIRECTORY}/maplibre-gl.css`, location.href);
    if (globalThis.__grBuildStamp)
      styleUrl.searchParams.set('v', globalThis.__grBuildStamp);
    mapLibreStylePromise = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = styleUrl.href;
      link.dataset.grAisMaplibreStyle = '';
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', () => {
        link.remove();
        mapLibreStylePromise = null;
        reject(new Error(`could not load MapLibre stylesheet ${styleUrl.href}`));
      }, { once: true });
      document.head.append(link);
    });
    return mapLibreStylePromise;
  }

  let mapLibrePromise = null;
  function loadMapLibre() {
    if (mapLibrePromise) return mapLibrePromise;
    const moduleUrl = new URL(`${MAPLIBRE_DIRECTORY}/maplibre-gl.mjs`, location.href);
    const workerUrl = new URL(`${MAPLIBRE_DIRECTORY}/maplibre-gl-worker.mjs`, location.href);
    if (globalThis.__grBuildStamp) {
      moduleUrl.searchParams.set('v', globalThis.__grBuildStamp);
      workerUrl.searchParams.set('v', globalThis.__grBuildStamp);
    }
    mapLibrePromise = Promise.all([loadMapLibreStyle(), import(moduleUrl.href)])
      .then(([, module]) => {
        module.setWorkerUrl(workerUrl.href);
        return module;
      })
      .catch(error => {
        mapLibrePromise = null;
        throw error;
      });
    return mapLibrePromise;
  }

  // ---------------------------------------------------------------------------
  // The renderer: one per block instance.
  // ---------------------------------------------------------------------------

  class AisMapRenderer {
    constructor(id, options) {
      this.id = id;
      this.blockName = String(options.blockName || `ais_map_${id}`);
      this.title = String(options.title || 'AIS Map');
      this.basemap = ['light', 'dark', 'none'].includes(options.basemap)
        ? options.basemap : 'light';
      this.units = options.units === 'metric' ? 'metric' : 'nautical';
      this.showReceiver = !!options.showReceiver;
      this.receiverLatitude = clamp(numeric(options.receiverLatitude) ?? 0, -90, 90);
      this.receiverLongitude = clamp(numeric(options.receiverLongitude) ?? 0, -180, 180);
      this.showLabels = options.showLabels !== false;
      this.showTrails = true;
      this.trailSeconds = Math.max(0, numeric(options.trailSeconds) ?? 1800);
      this.staleSeconds = Math.max(1, numeric(options.staleSeconds) ?? 180);
      this.expireSeconds = Math.max(this.staleSeconds + 1,
        numeric(options.expireSeconds) ?? 1200);
      this.vessels = new Map();
      this.assembler = new SentenceAssembler();
      this.messagesDecoded = 0;
      this.messagesRejected = 0;
      this.selectedMmsi = '';
      this.followSelected = false;
      this.searchText = '';
      this.map = null;
      this.mapModule = null;
      this.styleReady = false;
      this.remoteStyleLoaded = false;
      this.mapInitializationStarted = false;
      this.hasInitialFit = false;
      this.destroyed = false;
      this.dirty = true;
      this.buildDom();
      this.installControls();
      this.housekeepingTimer = setInterval(() => this.housekeeping(), 1000);
      this.animationFrame = requestAnimationFrame(() => this.frame());
    }

    buildDom() {
      this.root = document.createElement('section');
      this.root.className = 'gr-ais-map';
      this.root.dataset.blockName = this.blockName;
      this.root.dataset.blockId = 'wasm_ais_map_sink';
      this.root.setAttribute('aria-label', `${this.title} AIS vessel map`);
      Object.assign(this.root.style, {
        position: 'fixed', left: '0', top: '0', width: '1px', height: '1px',
        zIndex: '10000', display: 'none', flexDirection: 'column', overflow: 'hidden',
        boxSizing: 'border-box', border: '1px solid #263c54', borderRadius: '3px',
        background: '#07121f', color: '#dce9f7', font: UI_FONT,
        pointerEvents: 'auto', userSelect: 'none',
      });

      this.toolbar = document.createElement('div');
      Object.assign(this.toolbar.style, {
        minHeight: '38px', display: 'flex', alignItems: 'center', gap: '6px',
        padding: '4px 6px', boxSizing: 'border-box', background: '#0b1a2b',
        borderBottom: '1px solid #263c54', overflow: 'hidden',
      });
      this.titleElement = document.createElement('strong');
      this.titleElement.textContent = this.title;
      Object.assign(this.titleElement.style, {
        flex: '1 1 140px', minWidth: '0', marginRight: 'auto',
        overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', color: '#f0f6ff',
      });
      this.fitButton = makeButton('Fit all', 'fit', 'Fit every positioned vessel');
      this.homeButton = makeButton('Home', 'home', 'Center the receiver or fit all vessels');
      this.followButton = makeButton('Follow', 'follow', 'Follow the selected vessel');
      this.labelsButton = makeButton('Labels', 'labels', 'Show or hide vessel labels');
      this.trailsButton = makeButton('Trails', 'trails', 'Show or hide recent tracks');
      this.toolbar.append(this.titleElement, this.fitButton, this.homeButton,
        this.followButton, this.labelsButton, this.trailsButton);

      this.content = document.createElement('div');
      Object.assign(this.content.style, {
        minHeight: '0', flex: '1 1 auto', display: 'flex', overflow: 'hidden',
      });
      this.mapHost = document.createElement('div');
      this.mapHost.className = 'gr-ais-map-surface';
      Object.assign(this.mapHost.style, {
        position: 'relative', flex: '1 1 auto', minWidth: '180px',
        minHeight: '150px', background: '#07121f', overflow: 'hidden',
      });
      this.loading = document.createElement('div');
      this.loading.textContent = 'Loading map…';
      Object.assign(this.loading.style, {
        position: 'absolute', inset: '0', zIndex: '2', display: 'flex',
        alignItems: 'center', justifyContent: 'center', color: '#91a8c1',
        pointerEvents: 'none',
      });
      this.overlay = document.createElement('canvas');
      this.overlay.className = 'gr-ais-vessel-overlay';
      this.overlay.setAttribute('aria-label', 'Decoded AIS vessel positions');
      Object.assign(this.overlay.style, {
        position: 'absolute', inset: '0', zIndex: '3', width: '100%', height: '100%',
        pointerEvents: 'none',
      });
      this.context = this.overlay.getContext('2d');
      this.mapHost.append(this.loading, this.overlay);

      this.side = document.createElement('aside');
      Object.assign(this.side.style, {
        width: '292px', flex: '0 0 292px', display: 'flex', flexDirection: 'column',
        minHeight: '0', background: '#0b1726', borderLeft: '1px solid #263c54',
      });
      this.search = document.createElement('input');
      this.search.type = 'search';
      this.search.placeholder = 'Search name, call sign or MMSI';
      this.search.setAttribute('aria-label', 'Search vessels');
      Object.assign(this.search.style, {
        margin: '7px', padding: '6px 8px', border: '1px solid #38516c',
        borderRadius: '4px', background: '#07121f', color: '#e9f2fd', font: UI_FONT,
      });
      this.list = document.createElement('div');
      this.list.className = 'gr-ais-vessel-list';
      Object.assign(this.list.style, {
        minHeight: '70px', flex: '1 1 auto', overflow: 'auto',
        borderTop: '1px solid #263c54', borderBottom: '1px solid #263c54',
      });
      this.details = document.createElement('div');
      this.details.className = 'gr-ais-vessel-details';
      this.details.textContent = 'Select a vessel';
      Object.assign(this.details.style, {
        flex: '0 0 auto', maxHeight: '48%', overflow: 'auto', padding: '8px',
        boxSizing: 'border-box', color: '#afc1d5', font: UI_MONO_FONT,
      });
      this.side.append(this.search, this.list, this.details);
      this.content.append(this.mapHost, this.side);

      this.status = document.createElement('div');
      this.status.className = 'gr-ais-map-status';
      Object.assign(this.status.style, {
        minHeight: '25px', padding: '4px 8px', boxSizing: 'border-box',
        background: '#081522', borderTop: '1px solid #263c54', color: '#9fb5ca',
        font: UI_MONO_FONT, whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis',
      });
      this.root.append(this.toolbar, this.content, this.status);
      document.body.append(this.root);
      this.updateButtonStates();
      this.updateStatus();
    }

    installControls() {
      this.toolbar.addEventListener('click', event => {
        const action = event.target?.closest?.('button')?.dataset?.action;
        if (action === 'fit') this.fitAll();
        else if (action === 'home') this.goHome();
        else if (action === 'follow') {
          this.followSelected = !!this.selectedMmsi && !this.followSelected;
          this.followVessel();
        } else if (action === 'labels') this.showLabels = !this.showLabels;
        else if (action === 'trails') {
          this.showTrails = !this.showTrails;
          this.updateMapData();
        }
        this.updateButtonStates();
        this.dirty = true;
      });
      this.search.addEventListener('input', () => {
        this.searchText = this.search.value.trim().toUpperCase();
        this.rebuildList();
      });
      this.list.addEventListener('click', event => {
        const row = event.target?.closest?.('[data-mmsi]');
        if (row) this.select(row.dataset.mmsi);
      });
    }

    async initializeMap() {
      try {
        const maplibre = await loadMapLibre();
        if (this.destroyed) return;
        this.mapModule = maplibre;
        const center = this.showReceiver
          ? [this.receiverLongitude, this.receiverLatitude] : [0, 20];
        const style = this.basemap === 'none'
          ? localStyle(true) : STYLE_URLS[this.basemap];
        this.map = new maplibre.Map({
          container: this.mapHost,
          style,
          center,
          zoom: this.showReceiver ? 9 : 1.25,
          attributionControl: true,
          preserveDrawingBuffer: true,
        });
        this.map.addControl(new maplibre.NavigationControl({ showCompass: true }), 'top-right');
        this.map.on('style.load', () => {
          this.styleReady = true;
          this.remoteStyleLoaded ||= this.basemap !== 'none';
          this.loading.style.display = 'none';
          this.ensureMapLayers();
          this.updateMapData();
          this.dirty = true;
        });
        this.map.on('render', () => { this.dirty = true; });
        this.map.on('click', event => this.selectAtPoint(event.point));
        this.map.on('dragstart', event => {
          if (event.originalEvent) this.followSelected = false;
          this.updateButtonStates();
        });
        this.map.on('zoomstart', event => {
          if (event.originalEvent) this.followSelected = false;
          this.updateButtonStates();
        });
        if (this.basemap !== 'none') {
          this.styleFallbackTimer = setTimeout(() => this.fallbackStyle(), 10000);
          this.map.once('load', () => clearTimeout(this.styleFallbackTimer));
          this.map.once('error', () => {
            if (!this.map?.loaded()) this.fallbackStyle();
          });
        }
      } catch (error) {
        this.loading.textContent = `Map unavailable: ${error?.message || error}`;
        this.loading.style.color = '#ff9c9c';
        console.error(`AIS Map: ${error?.message || error}`);
      }
    }

    fallbackStyle() {
      if (!this.map || this.destroyed || this.map.loaded()) return;
      clearTimeout(this.styleFallbackTimer);
      this.loading.textContent = 'Using offline map';
      this.map.setStyle(localStyle(true));
    }

    ensureMapLayers() {
      if (!this.map?.isStyleLoaded()) return;
      const addSource = (id, data) => {
        if (!this.map.getSource(id)) this.map.addSource(id, { type: 'geojson', data });
      };
      addSource('gr-ais-graticule', graticuleGeoJson());
      addSource('gr-ais-trails', emptyFeatures());
      addSource('gr-ais-rings', emptyFeatures());
      addSource('gr-ais-receiver', emptyFeatures());
      if (!this.map.getLayer('gr-ais-graticule-line')) {
        this.map.addLayer({ id: 'gr-ais-graticule-line', type: 'line',
          source: 'gr-ais-graticule', paint: {
            'line-color': this.basemap === 'light' ? '#71889a' : '#54708a',
            'line-width': 0.7, 'line-opacity': this.basemap === 'none' ? 0.45 : 0.18,
          } });
      }
      if (!this.map.getLayer('gr-ais-trail-line')) {
        this.map.addLayer({ id: 'gr-ais-trail-line', type: 'line',
          source: 'gr-ais-trails', paint: {
            'line-color': ['coalesce', ['get', 'color'], '#67d5ff'],
            'line-width': 2, 'line-opacity': 0.72,
          } });
      }
      if (!this.map.getLayer('gr-ais-ring-line')) {
        this.map.addLayer({ id: 'gr-ais-ring-line', type: 'line',
          source: 'gr-ais-rings', paint: {
            'line-color': '#68d6e8', 'line-width': 1,
            'line-dasharray': [3, 3], 'line-opacity': 0.65,
          } });
      }
      if (!this.map.getLayer('gr-ais-receiver-dot')) {
        this.map.addLayer({ id: 'gr-ais-receiver-dot', type: 'circle',
          source: 'gr-ais-receiver', paint: {
            'circle-radius': 5, 'circle-color': '#ffffff',
            'circle-stroke-width': 2, 'circle-stroke-color': '#17c9dc',
          } });
      }
    }

    // A batch from the block: [{payload: "<hex>"} | {nmea: "..."} | {dropped: n}].
    update(rawBatch) {
      let batch;
      try { batch = typeof rawBatch === 'string' ? JSON.parse(rawBatch) : rawBatch; }
      catch (error) {
        console.warn(`AIS Map ignored invalid update JSON: ${error?.message || error}`);
        return;
      }
      if (!Array.isArray(batch)) return;
      const now = performance.now();
      for (const packet of batch) {
        if (!packet || typeof packet !== 'object') continue;
        if (packet.dropped) {
          this.messagesRejected += numeric(packet.dropped) ?? 0;
          continue;
        }
        const bits = packet.nmea != null
          ? this.assembler.push(packet.nmea)
          : bitsFromHex(packet.payload);
        if (bits === null && packet.nmea != null && parseNmeaSentence(packet.nmea)) continue;
        const message = bits ? decodeAisPayload(bits) : null;
        if (!message) {
          this.messagesRejected++;
          continue;
        }
        this.messagesDecoded++;
        this.mergeMessage(message, now);
      }
      this.updateMapData();
      this.rebuildList();
      this.updateDetails();
      this.updateStatus();
      if (!this.hasInitialFit && this.positionedVessels().length) {
        this.hasInitialFit = true;
        setTimeout(() => this.fitAll(), 0);
      }
      this.followVessel();
      this.dirty = true;
    }

    mergeMessage(message, now) {
      const mmsi = formatMmsi(message.mmsi);
      if (!mmsi) return;
      if (!this.vessels.has(mmsi) && this.vessels.size >= MAX_VESSELS) {
        const oldest = [...this.vessels.values()]
          .sort((left, right) => left.receivedAt - right.receivedAt)[0];
        if (oldest) this.vessels.delete(oldest.mmsi);
      }
      const previous = this.vessels.get(mmsi) || { mmsi, trail: [], num_msgs: 0, kind: 'A' };
      const next = { ...previous, receivedAt: now, num_msgs: previous.num_msgs + 1,
        last_type: message.type };
      if (message.base_station) next.kind = 'base';
      else if (message.aid_to_navigation) next.kind = 'aton';
      else if (message.sar_aircraft) next.kind = 'sar';
      else if (message.class_b) next.kind = 'B';
      else if ([1, 2, 3, 5].includes(message.type)) next.kind = 'A';

      for (const name of ['name', 'callsign', 'destination'])
        if (typeof message[name] === 'string' && message[name]) next[name] = message[name];
      for (const name of ['ship_type', 'length', 'beam', 'draught', 'imo', 'aid_type',
        'altitude'])
        if (numeric(message[name]) != null) next[name] = numeric(message[name]);
      // A position report says what it says: an unavailable field in it
      // replaces an older value rather than leaving a stale one on screen.
      const positional = [1, 2, 3, 9, 18, 19, 27].includes(message.type);
      for (const name of ['sog', 'cog', 'heading', 'rot', 'nav_status']) {
        if (name in message) next[name] = message[name];
        else if (positional && name !== 'nav_status' && name !== 'rot') next[name] = null;
      }
      next.color = vesselColor(next);
      const positioned = Number.isFinite(message.latitude) && Number.isFinite(message.longitude);
      if (positioned) {
        next.latitude = message.latitude;
        next.longitude = message.longitude;
        const last = next.trail[next.trail.length - 1];
        const distance = last
          ? haversineKm(last.latitude, last.longitude, next.latitude, next.longitude) : null;
        if (!last || distance >= 0.02 || now - last.receivedAt >= 5000) {
          next.trail = [...next.trail, { latitude: next.latitude,
            longitude: next.longitude, receivedAt: now }].slice(-MAX_TRAIL_POINTS);
        }
      }
      this.vessels.set(mmsi, next);
    }

    positionedVessels() {
      return [...this.vessels.values()].filter(vessel =>
        Number.isFinite(vessel.latitude) && Number.isFinite(vessel.longitude));
    }

    housekeeping() {
      const now = performance.now();
      let removed = false;
      for (const [mmsi, vessel] of this.vessels) {
        if (now - vessel.receivedAt > this.expireSeconds * 1000) {
          this.vessels.delete(mmsi);
          if (this.selectedMmsi === mmsi) {
            this.selectedMmsi = '';
            this.followSelected = false;
          }
          removed = true;
        } else {
          vessel.trail = vessel.trail.filter(point =>
            now - point.receivedAt <= this.trailSeconds * 1000);
        }
      }
      if (removed || this.vessels.size) {
        this.updateMapData();
        this.rebuildList();
        this.updateDetails();
        this.updateStatus();
        this.dirty = true;
      }
    }

    receiverDistance(vessel) {
      if (!this.showReceiver) return null;
      return haversineKm(this.receiverLatitude, this.receiverLongitude,
        vessel.latitude, vessel.longitude);
    }

    receiverBearing(vessel) {
      if (!this.showReceiver) return null;
      return bearingDegrees(this.receiverLatitude, this.receiverLongitude,
        vessel.latitude, vessel.longitude);
    }

    updateMapData() {
      if (!this.styleReady || !this.map?.isStyleLoaded()) return;
      this.ensureMapLayers();
      const now = performance.now();
      const trailFeatures = [];
      if (this.showTrails && this.trailSeconds > 0) {
        for (const vessel of this.positionedVessels()) {
          const coordinates = vessel.trail
            .filter(point => now - point.receivedAt <= this.trailSeconds * 1000)
            .map(point => [point.longitude, point.latitude]);
          if (coordinates.length > 1) trailFeatures.push({
            type: 'Feature', properties: { mmsi: vessel.mmsi, color: vessel.color },
            geometry: { type: 'LineString', coordinates },
          });
        }
      }
      this.map.getSource('gr-ais-trails')?.setData({
        type: 'FeatureCollection', features: trailFeatures,
      });

      const receiverFeatures = this.showReceiver ? [{
        type: 'Feature', properties: { name: 'Receiver' },
        geometry: { type: 'Point',
          coordinates: [this.receiverLongitude, this.receiverLatitude] },
      }] : [];
      this.map.getSource('gr-ais-receiver')?.setData({
        type: 'FeatureCollection', features: receiverFeatures,
      });
      const ringFeatures = [];
      if (this.showReceiver) {
        // VHF range: 10, 20 and 40 nautical miles.
        for (const radius of [18.52, 37.04, 74.08]) {
          const coordinates = [];
          for (let angle = 0; angle <= 360; angle += 4)
            coordinates.push(destinationPoint(this.receiverLatitude,
              this.receiverLongitude, angle, radius));
          ringFeatures.push({ type: 'Feature', properties: { radius },
            geometry: { type: 'LineString', coordinates } });
        }
      }
      this.map.getSource('gr-ais-rings')?.setData({
        type: 'FeatureCollection', features: ringFeatures,
      });
    }

    vesselLabel(vessel) {
      return vessel.name || vessel.mmsi;
    }

    vesselKindText(vessel) {
      if (vessel.kind === 'base') return 'Base station';
      if (vessel.kind === 'aton')
        return `AtoN: ${AID_TYPES[vessel.aid_type] || 'Unspecified'}`;
      if (vessel.kind === 'sar') return 'SAR aircraft';
      return `${shipTypeText(vessel.ship_type)} (class ${vessel.kind})`;
    }

    formatSpeed(value) {
      if (!Number.isFinite(value)) return '—';
      return this.units === 'metric'
        ? `${(value * 1.852).toFixed(value < 10 ? 1 : 0)} km/h`
        : `${value.toFixed(1)} kn`;
    }

    formatDistance(value) {
      if (!Number.isFinite(value)) return '—';
      return this.units === 'metric'
        ? `${value.toFixed(value < 10 ? 1 : 0)} km`
        : `${(value / 1.852).toFixed(value < 18.52 ? 1 : 0)} NM`;
    }

    formatRateOfTurn(value) {
      if (value == null || Number.isNaN(value)) return '—';
      if (value === Infinity) return '> 5°/30 s right';
      if (value === -Infinity) return '> 5°/30 s left';
      if (Math.abs(value) < 0.05) return '0°/min';
      return `${Math.abs(value).toFixed(1)}°/min ${value > 0 ? 'right' : 'left'}`;
    }

    sortedVessels() {
      return [...this.vessels.values()].sort((left, right) => {
        const leftDistance = this.receiverDistance(left);
        const rightDistance = this.receiverDistance(right);
        if (leftDistance != null && rightDistance != null)
          return leftDistance - rightDistance;
        return right.receivedAt - left.receivedAt || left.mmsi.localeCompare(right.mmsi);
      });
    }

    rebuildList() {
      const fragment = document.createDocumentFragment();
      const now = performance.now();
      for (const vessel of this.sortedVessels()) {
        const searchValue = `${vessel.mmsi} ${vessel.name || ''} ${vessel.callsign || ''}`
          .toUpperCase();
        if (this.searchText && !searchValue.includes(this.searchText)) continue;
        const row = document.createElement('button');
        row.type = 'button';
        row.dataset.mmsi = vessel.mmsi;
        row.className = 'gr-ais-vessel-row';
        row.setAttribute('aria-label', `Select ${this.vesselLabel(vessel)}`);
        Object.assign(row.style, {
          width: '100%', display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 8px',
          padding: '6px 8px', boxSizing: 'border-box', textAlign: 'left',
          border: '0', borderBottom: '1px solid #1d3248', cursor: 'pointer',
          color: '#dce9f7', background: vessel.mmsi === this.selectedMmsi
            ? '#173b4b' : '#0b1726', font: UI_MONO_FONT,
          opacity: now - vessel.receivedAt > this.staleSeconds * 1000 ? '0.45' : '1',
        });
        const identity = document.createElement('strong');
        identity.textContent = this.vesselLabel(vessel);
        identity.style.color = vessel.color;
        const speed = document.createElement('span');
        speed.textContent = vessel.kind === 'base' || vessel.kind === 'aton'
          ? '' : this.formatSpeed(vessel.sog);
        const detail = document.createElement('span');
        detail.textContent = vessel.name ? vessel.mmsi : this.vesselKindText(vessel);
        detail.style.color = '#8199b1';
        const course = document.createElement('span');
        course.textContent = Number.isFinite(vessel.cog) ? `${vessel.cog.toFixed(0)}°` : '';
        course.style.color = '#9db2c7';
        row.append(identity, speed, detail, course);
        fragment.append(row);
      }
      this.list.replaceChildren(fragment);
      if (!this.list.childElementCount) {
        const empty = document.createElement('div');
        empty.textContent = this.vessels.size ? 'No matching vessels' : 'Waiting for AIS packets…';
        Object.assign(empty.style, { padding: '12px', color: '#8199b1' });
        this.list.append(empty);
      }
    }

    updateDetails() {
      const vessel = this.vessels.get(this.selectedMmsi);
      if (!vessel) {
        this.details.textContent = 'Select a vessel';
        return;
      }
      const now = performance.now();
      const distance = this.receiverDistance(vessel);
      const bearing = this.receiverBearing(vessel);
      const moving = vessel.kind !== 'base' && vessel.kind !== 'aton';
      const rows = [
        ['Name', vessel.name || '—'],
        ['MMSI', vessel.mmsi],
        ...(vessel.callsign ? [['Call sign', vessel.callsign]] : []),
        ...(vessel.imo ? [['IMO', String(vessel.imo)]] : []),
        ['Type', this.vesselKindText(vessel)],
        ...(vessel.kind === 'A' && vessel.nav_status != null
          ? [['Status', NAV_STATUS[vessel.nav_status] || '—']] : []),
        ...(moving ? [
          ['Speed', this.formatSpeed(vessel.sog)],
          ['Course', Number.isFinite(vessel.cog) ? `${vessel.cog.toFixed(1)}°` : '—'],
          ['Heading', Number.isFinite(vessel.heading) ? `${vessel.heading}°` : '—'],
        ] : []),
        ...(vessel.kind === 'A' ? [['Turn', this.formatRateOfTurn(vessel.rot)]] : []),
        ...(vessel.kind === 'sar' && Number.isFinite(vessel.altitude)
          ? [['Altitude', `${vessel.altitude} m`]] : []),
        ['Position', Number.isFinite(vessel.latitude) && Number.isFinite(vessel.longitude)
          ? `${vessel.latitude.toFixed(5)}, ${vessel.longitude.toFixed(5)}` : '—'],
        ...(vessel.destination ? [['Destination', vessel.destination]] : []),
        ...(vessel.length || vessel.beam
          ? [['Size', `${vessel.length || '?'} × ${vessel.beam || '?'} m`]] : []),
        ...(vessel.draught ? [['Draught', `${vessel.draught.toFixed(1)} m`]] : []),
        ...(this.showReceiver ? [
          ['Range', this.formatDistance(distance)],
          ['Bearing', Number.isFinite(bearing) ? `${bearing.toFixed(0)}°` : '—'],
        ] : []),
        ['Messages', `${vessel.num_msgs} (last type ${vessel.last_type})`],
        ['Age', formatAge(now - vessel.receivedAt)],
      ];
      const definition = document.createElement('dl');
      Object.assign(definition.style, {
        display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 9px', margin: '0',
      });
      for (const [label, value] of rows) {
        const term = document.createElement('dt');
        term.textContent = label;
        term.style.color = '#7892ab';
        const description = document.createElement('dd');
        description.textContent = String(value);
        description.style.margin = '0';
        definition.append(term, description);
      }
      this.details.replaceChildren(definition);
    }

    updateStatus() {
      const now = performance.now();
      const positioned = this.positionedVessels().length;
      const stale = [...this.vessels.values()].filter(vessel =>
        now - vessel.receivedAt > this.staleSeconds * 1000).length;
      const source = this.basemap === 'none' || (this.map && !this.remoteStyleLoaded)
        ? 'offline map' : `${this.basemap} map`;
      this.status.textContent = `${positioned} positioned / ${this.vessels.size} tracked` +
        `${stale ? ` · ${stale} stale` : ''} · ${this.messagesDecoded} msgs` +
        `${this.messagesRejected ? ` · ${this.messagesRejected} rejected` : ''} · ${source}`;
    }

    updateButtonStates() {
      const toggle = (button, active, enabled = true) => {
        button.disabled = !enabled;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.style.background = active ? '#174454' : '#12243a';
        button.style.borderColor = active ? '#45c9d8' : '#38516c';
        button.style.opacity = enabled ? '1' : '0.5';
      };
      toggle(this.followButton, this.followSelected, !!this.selectedMmsi);
      toggle(this.labelsButton, this.showLabels);
      toggle(this.trailsButton, this.showTrails);
    }

    select(mmsi) {
      if (!this.vessels.has(mmsi)) return;
      this.selectedMmsi = mmsi;
      this.rebuildList();
      this.updateDetails();
      this.updateButtonStates();
      const vessel = this.vessels.get(mmsi);
      if (this.map && Number.isFinite(vessel.latitude) && Number.isFinite(vessel.longitude))
        this.map.easeTo({ center: [vessel.longitude, vessel.latitude],
          zoom: Math.max(this.map.getZoom(), 10), duration: 450 });
      this.dirty = true;
    }

    selectAtPoint(point) {
      if (!this.map || !point) return;
      let nearest = null;
      for (const vessel of this.positionedVessels()) {
        const projected = this.map.project([vessel.longitude, vessel.latitude]);
        const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
        if (distance <= 18 && (!nearest || distance < nearest.distance))
          nearest = { vessel, distance };
      }
      if (nearest) this.select(nearest.vessel.mmsi);
    }

    followVessel() {
      if (!this.followSelected || !this.map) return;
      const vessel = this.vessels.get(this.selectedMmsi);
      if (vessel && Number.isFinite(vessel.latitude) && Number.isFinite(vessel.longitude))
        this.map.easeTo({ center: [vessel.longitude, vessel.latitude], duration: 250 });
    }

    fitAll() {
      if (!this.map || !this.mapModule) return;
      const positioned = this.positionedVessels();
      if (!positioned.length) return;
      this.followSelected = false;
      this.updateButtonStates();
      if (positioned.length === 1) {
        this.map.easeTo({ center: [positioned[0].longitude, positioned[0].latitude],
          zoom: Math.max(this.map.getZoom(), 10), duration: 450 });
        return;
      }
      const bounds = new this.mapModule.LngLatBounds();
      for (const vessel of positioned) bounds.extend([vessel.longitude, vessel.latitude]);
      this.map.fitBounds(bounds, { padding: 50, maxZoom: 12, duration: 500 });
    }

    goHome() {
      if (!this.map) return;
      this.followSelected = false;
      this.updateButtonStates();
      if (this.showReceiver)
        this.map.easeTo({ center: [this.receiverLongitude, this.receiverLatitude], zoom: 9, duration: 450 });
      else this.fitAll();
    }

    // The marker: a hull pointed along the heading (true heading, else course)
    // for a vessel that is moving, a dot for one that is not or has no
    // direction, a square for a base station and a diamond for an aid.
    drawMarker(context, vessel, selected) {
      const kind = vessel.kind;
      if (kind === 'base') {
        context.beginPath();
        context.rect(-6, -6, 12, 12);
      } else if (kind === 'aton') {
        context.beginPath();
        context.moveTo(0, -9);
        context.lineTo(8, 0);
        context.lineTo(0, 9);
        context.lineTo(-8, 0);
        context.closePath();
      } else {
        const direction = Number.isFinite(vessel.heading) ? vessel.heading
          : Number.isFinite(vessel.cog) ? vessel.cog : null;
        const moving = vessel.sog == null || vessel.sog >= 0.3;
        if (direction != null && moving) {
          context.rotate(radians(direction));
          context.beginPath();
          context.moveTo(0, -12);
          context.lineTo(6, -3);
          context.lineTo(6, 9);
          context.lineTo(-6, 9);
          context.lineTo(-6, -3);
          context.closePath();
        } else {
          context.beginPath();
          context.arc(0, 0, 6, 0, Math.PI * 2);
        }
      }
      context.fill();
      context.stroke();
      if (selected) {
        context.beginPath();
        context.arc(0, 0, 17, 0, Math.PI * 2);
        context.strokeStyle = '#ffffff';
        context.lineWidth = 1.5;
        context.stroke();
      }
    }

    drawVessels() {
      const width = Math.max(1, this.mapHost.clientWidth);
      const height = Math.max(1, this.mapHost.clientHeight);
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const pixelWidth = Math.round(width * ratio);
      const pixelHeight = Math.round(height * ratio);
      if (this.overlay.width !== pixelWidth || this.overlay.height !== pixelHeight) {
        this.overlay.width = pixelWidth;
        this.overlay.height = pixelHeight;
      }
      const context = this.context;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!this.map) return;
      const now = performance.now();
      context.font = UI_MONO_FONT;
      context.textBaseline = 'middle';
      for (const vessel of this.positionedVessels()) {
        const point = this.map.project([vessel.longitude, vessel.latitude]);
        if (point.x < -30 || point.y < -30 || point.x > width + 30 || point.y > height + 30)
          continue;
        const stale = now - vessel.receivedAt > this.staleSeconds * 1000;
        const selected = vessel.mmsi === this.selectedMmsi;
        context.save();
        context.globalAlpha = stale ? 0.38 : 1;
        context.translate(point.x, point.y);
        context.fillStyle = vessel.color;
        context.strokeStyle = selected ? '#ffffff' : '#07121f';
        context.lineWidth = selected ? 2.5 : 1.5;
        this.drawMarker(context, vessel, selected);
        context.restore();

        if (this.showLabels) {
          const speed = vessel.kind === 'base' || vessel.kind === 'aton' || vessel.sog == null
            ? '' : `  ${this.formatSpeed(vessel.sog)}`;
          const label = `${this.vesselLabel(vessel)}${speed}`;
          const textWidth = context.measureText(label).width;
          const x = point.x + 13;
          const y = point.y - 14;
          context.globalAlpha = stale ? 0.42 : 0.9;
          context.fillStyle = '#07121f';
          context.fillRect(x - 3, y - 10, textWidth + 6, 20);
          context.globalAlpha = stale ? 0.5 : 1;
          context.fillStyle = '#edf6ff';
          context.fillText(label, x, y);
        }
      }
      context.globalAlpha = 1;
    }

    frame() {
      if (this.destroyed) return;
      if (this.dirty) {
        this.dirty = false;
        this.drawVessels();
      }
      this.animationFrame = requestAnimationFrame(() => this.frame());
    }

    layout(x, y, width, height, visible) {
      if (!visible || width <= 0 || height <= 0) {
        this.root.style.display = 'none';
        return;
      }
      Object.assign(this.root.style, {
        display: 'flex', left: `${x}px`, top: `${y}px`,
        width: `${width}px`, height: `${height}px`,
      });
      if (!this.mapInitializationStarted) {
        this.mapInitializationStarted = true;
        this.initializeMap();
      }
      const compact = width < 720;
      this.side.style.width = compact ? '220px' : '292px';
      this.side.style.flexBasis = compact ? '220px' : '292px';
      this.list.style.display = compact && height < 430 ? 'none' : 'block';
      this.search.style.display = compact && height < 430 ? 'none' : 'block';
      this.map?.resize();
      this.dirty = true;
    }

    plotData(maxPoints = 32) {
      const now = performance.now();
      const limit = clamp(Math.floor(numeric(maxPoints) ?? 32), 1, MAX_VESSELS);
      const values = this.sortedVessels();
      const vessels = values.slice(0, limit).map(value => ({
        mmsi: value.mmsi,
        name: value.name || null,
        callsign: value.callsign || null,
        kind: value.kind,
        ship_type: numeric(value.ship_type),
        ship_type_text: value.kind === 'A' || value.kind === 'B'
          ? shipTypeText(value.ship_type) : this.vesselKindText(value),
        nav_status: value.nav_status != null ? NAV_STATUS[value.nav_status] || null : null,
        latitude: numeric(value.latitude),
        longitude: numeric(value.longitude),
        speed_kt: numeric(value.sog),
        course_deg: numeric(value.cog),
        heading_deg: numeric(value.heading),
        destination: value.destination || null,
        messages: value.num_msgs,
        age_seconds: Math.max(0, (now - value.receivedAt) / 1000),
        stale: now - value.receivedAt > this.staleSeconds * 1000,
        selected: value.mmsi === this.selectedMmsi,
        distance_km: this.receiverDistance(value),
        bearing_from_receiver: this.receiverBearing(value),
      }));
      const center = this.map?.getCenter();
      return {
        name: this.blockName,
        id: 'wasm_ais_map_sink',
        kind: 'map',
        title: this.title,
        units: this.units,
        basemap: this.basemap,
        vessel_total: values.length,
        positioned_vessels: this.positionedVessels().length,
        messages_decoded: this.messagesDecoded,
        messages_rejected: this.messagesRejected,
        vessels,
        selected_mmsi: this.selectedMmsi || null,
        viewport: center ? { longitude: center.lng, latitude: center.lat,
          zoom: this.map.getZoom() } : null,
        receiver: this.showReceiver ? { latitude: this.receiverLatitude,
          longitude: this.receiverLongitude } : null,
      };
    }

    captureLayers() {
      if (this.root.style.display === 'none') return [];
      const rect = this.mapHost.getBoundingClientRect();
      const layers = [];
      const mapCanvas = this.map?.getCanvas();
      if (mapCanvas?.width && mapCanvas?.height)
        layers.push({ source: mapCanvas, rect, widget: this.blockName, z: 10 });
      if (this.overlay.width && this.overlay.height)
        layers.push({ source: this.overlay, rect, widget: this.blockName, z: 11 });
      return layers;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      clearInterval(this.housekeepingTimer);
      clearTimeout(this.styleFallbackTimer);
      cancelAnimationFrame(this.animationFrame);
      this.map?.remove();
      this.root.remove();
    }
  }

  class AisMapManager {
    constructor() { this.instances = new Map(); this.nextId = 1; }
    create(encodedOptions) {
      try {
        const options = typeof encodedOptions === 'string'
          ? JSON.parse(encodedOptions) : encodedOptions || {};
        const id = this.nextId++;
        this.instances.set(id, new AisMapRenderer(id, options));
        return id;
      } catch (error) {
        console.error(`AIS Map: ${error?.message || error}`);
        return 0;
      }
    }
    update(id, encodedBatch) { this.instances.get(id)?.update(encodedBatch); }
    destroy(id) { this.instances.get(id)?.destroy(); this.instances.delete(id); }
    widgets() {
      return [...this.instances.values()].map(instance => ({
        name: instance.blockName, id: 'wasm_ais_map_sink',
        rect: instance.root.getBoundingClientRect(),
      }));
    }
    readPlotData(only = '', maxPoints = 32) {
      const widgets = [...this.instances.values()]
        .filter(instance => !only || instance.blockName === only)
        .map(instance => instance.plotData(maxPoints));
      return { widgets, ...(only && !widgets.length
        ? { error: `no GUI widget named "${only}" is running` } : {}) };
    }
    captureLayers(only = '') {
      return [...this.instances.values()]
        .filter(instance => !only || instance.blockName === only)
        .flatMap(instance => instance.captureLayers());
    }
    applyLayoutReport(report) {
      const widgets = report && Array.isArray(report.widgets) ? report.widgets : [];
      for (const instance of this.instances.values()) {
        const placed = widgets.find(widget => widget?.name === instance.blockName);
        if (placed?.rect && placed.visible !== false) {
          const { x, y, width, height } = placed.rect;
          instance.layout(x, y, width, height, true);
        } else instance.layout(0, 0, 0, 0, false);
      }
    }
  }

  globalThis.__grAisMapInternals = {
    bitsFromArmor, bitsFromHex, decodeAisPayload, parseNmeaSentence, SentenceAssembler,
    formatMmsi, shipTypeText, vesselClass, vesselColor, haversineKm, bearingDegrees,
    destinationPoint, formatAge, localStyle, graticuleGeoJson, loadMapLibreStyle,
    NAV_STATUS, AID_TYPES, AisMapRenderer,
  };
  const manager = new AisMapManager();
  globalThis.__grAisMap = manager;
  (globalThis.__grGuiLayoutListeners ||= []).push(report => manager.applyLayoutReport(report));
  globalThis.__grGuiObservation?.register('ais-map', {
    widgets: () => manager.widgets(),
    readPlotData: (only, maxPoints) => manager.readPlotData(only, maxPoints),
    captureLayers: only => manager.captureLayers(only),
  }, 10);
})();
