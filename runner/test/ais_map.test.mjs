import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import vm from 'node:vm';

const source = await readFile(new URL('../src/ais_map.js', import.meta.url), 'utf8');
const appendedStyles = [];
const sandbox = {
  console,
  URL,
  location: { href: 'https://example.test/runner/runner.html' },
  __grBuildStamp: 'test-build',
  document: {
    createElement(tagName) {
      assert.equal(tagName, 'link');
      const listeners = {};
      return {
        dataset: {},
        addEventListener(type, listener) { listeners[type] = listener; },
        dispatch(type) { listeners[type]?.(); },
        remove() {},
      };
    },
    head: {
      append(element) {
        appendedStyles.push(element);
        element.dispatch('load');
      },
    },
  },
};
vm.runInNewContext(source, sandbox, { filename: 'ais_map.js' });
const {
  bitsFromArmor, bitsFromHex, decodeAisPayload, parseNmeaSentence, SentenceAssembler,
  formatMmsi, shipTypeText, vesselClass, vesselColor, loadMapLibreStyle, NAV_STATUS,
  AisMapRenderer,
} = sandbox.__grAisMapInternals;

const runnerHtml = await readFile(new URL('../src/runner.html', import.meta.url), 'utf8');
assert.match(runnerHtml, /<script src="ais_map\.js"><\/script>/,
  'the runner page loads the AIS map bridge');
assert.equal(appendedStyles.length, 0, 'evaluating the AIS map bridge does not load MapLibre CSS');
assert.strictEqual(loadMapLibreStyle(), loadMapLibreStyle(),
  'multiple AIS Map blocks share one stylesheet load');
await loadMapLibreStyle();
assert.equal(appendedStyles.length, 1);
assert.equal(appendedStyles[0].dataset.grAisMaplibreStyle, '');
assert.equal(appendedStyles[0].href,
  'https://example.test/runner/maplibre-6.8.0/maplibre-gl.css?v=test-build');

// --- The two input forms decode identically -------------------------------
// gr-ais's QA reference packet: the 21 payload bytes HDLC Deframer emits, and
// the sentence AIS PDU to NMEA prints for them.
const referenceHex = '0471db85a1400005cff1fa1b3a2441fe5a9e0246d8';
const referenceSentence = '!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C';
const fromBytes = decodeAisPayload(bitsFromHex(referenceHex));
const fromSentence = decodeAisPayload(new SentenceAssembler().push(referenceSentence));
assert.deepEqual(JSON.parse(JSON.stringify(fromBytes)), JSON.parse(JSON.stringify(fromSentence)),
  'a deframed payload and its NMEA sentence decode to the same message');
assert.equal(fromBytes.type, 1);
assert.equal(fromBytes.mmsi, 477553000);
assert.equal(fromBytes.nav_status, 5, 'moored');
assert.equal(fromBytes.rot, 0);
assert.equal(fromBytes.sog, 0);
assert.ok(Math.abs(fromBytes.longitude + 122.345833) < 1e-5);
assert.ok(Math.abs(fromBytes.latitude - 47.582833) < 1e-5);
assert.equal(fromBytes.cog, 51);
assert.equal(fromBytes.heading, 181);

// --- Sentences -------------------------------------------------------------
assert.equal(parseNmeaSentence('!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5D'), null,
  'a checksum mismatch rejects the sentence');
assert.equal(parseNmeaSentence('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9*47'), null,
  'only AIVDM/AIVDO sentences are accepted');
const fields = parseNmeaSentence(referenceSentence);
assert.deepEqual(JSON.parse(JSON.stringify(fields)), { count: 1, index: 1, sequence: '', channel: 'B',
  payload: '177KQJ5000G?tO`K>RA1wUbN0TKH', fill: 0 });
assert.equal(bitsFromArmor('w').join(''), '111111', 'the armor skips the 8 codes above "W"');
assert.equal(bitsFromArmor('0', 2).join(''), '0000', 'fill bits come off the end');
assert.equal(bitsFromArmor('~'), null, 'a character outside the armor is rejected');
assert.equal(bitsFromHex('0g'), null);

// A real Thames-estuary report out of the hosted sdrangel/ais recording.
const thames = decodeAisPayload(new SentenceAssembler()
  .push('!AIVDM,1,1,,A,23P<wNmP0sP1AStMLNTrk?vl25Ip,0*12'));
assert.equal(thames.type, 2);
assert.equal(thames.mmsi, 235093883);
assert.equal(thames.sog, 5.9);
assert.equal(thames.cog, 276.4);
assert.equal(thames.heading, null, '511 is "not available"');
assert.equal(thames.rot, null, '-128 is "not available"');
assert.ok(Math.abs(thames.latitude - 51.458805) < 1e-6);
assert.ok(Math.abs(thames.longitude - 0.278397) < 1e-6);

// --- Multi-sentence static data ---------------------------------------------
// The published EVER DIADEM type 5 example: two fragments, two fill bits.
const assembler = new SentenceAssembler();
assert.equal(assembler.push(
  '!AIVDM,2,1,1,A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8,0*1C'), null,
'the first fragment waits for the second');
const staticBits = assembler.push('!AIVDM,2,2,1,A,88888888880,2*25');
assert.equal(staticBits.length, 424);
const staticData = decodeAisPayload(staticBits);
assert.equal(staticData.type, 5);
assert.equal(staticData.mmsi, 351759000);
assert.equal(staticData.imo, 9134270);
assert.equal(staticData.callsign, '3FOF8');
assert.equal(staticData.name, 'EVER DIADEM');
assert.equal(staticData.ship_type, 70);
assert.equal(staticData.length, 295);
assert.equal(staticData.beam, 32);
assert.equal(staticData.draught, 12.2);
assert.equal(staticData.destination, 'NEW YORK');
assert.equal(assembler.partial.size, 0, 'a completed message leaves no partial behind');

assert.equal(formatMmsi(2320001), '002320001', 'MMSIs keep their leading zeros');
assert.equal(shipTypeText(70), 'Cargo');
assert.equal(shipTypeText(82), 'Tanker, hazardous cat. B');
assert.equal(shipTypeText(30), 'Fishing');
assert.equal(shipTypeText(null), 'Unknown');
assert.equal(vesselClass({ kind: 'A', ship_type: 84 }), 'tanker');
assert.equal(vesselClass({ kind: 'base' }), 'base');
assert.notEqual(vesselColor({ kind: 'A', ship_type: 70 }), vesselColor({ kind: 'A', ship_type: 80 }));
assert.equal(NAV_STATUS[5], 'Moored');

// --- The merge: position reports and static data accumulate per MMSI ------
const renderer = Object.create(AisMapRenderer.prototype);
renderer.vessels = new Map();
renderer.showReceiver = false;
renderer.receiverLatitude = 0;
renderer.receiverLongitude = 0;
renderer.mergeMessage(thames, 1000);
let vessel = renderer.vessels.get('235093883');
assert.equal(vessel.kind, 'A');
assert.equal(vessel.num_msgs, 1);
assert.equal(vessel.sog, 5.9);
assert.equal(vessel.trail.length, 1);
assert.equal(vessel.name, undefined, 'no name until static data arrives');

renderer.mergeMessage({ type: 5, mmsi: 235093883, name: 'THAMES BARGE', callsign: 'MABC',
  ship_type: 70, destination: 'GRAVESEND' }, 1500);
vessel = renderer.vessels.get('235093883');
assert.equal(vessel.name, 'THAMES BARGE');
assert.equal(vessel.latitude, thames.latitude, 'static data does not touch the position');
assert.equal(vessel.sog, 5.9, 'nor the last reported motion');
assert.equal(vessel.num_msgs, 2);
assert.equal(vesselClass(vessel), 'cargo');

renderer.mergeMessage({ type: 1, mmsi: 235093883, latitude: 51.4589, longitude: 0.2785,
  sog: null, cog: null, heading: null, rot: null, nav_status: 1 }, 2000);
vessel = renderer.vessels.get('235093883');
assert.equal(vessel.sog, null, 'a position report with speed unavailable says so');
assert.equal(vessel.nav_status, 1);
assert.equal(vessel.name, 'THAMES BARGE', 'the name survives later position reports');
assert.equal(vessel.trail.length, 1, 'a 2 m move within 5 s does not grow the trail');

renderer.mergeMessage({ type: 18, mmsi: 235093883, class_b: true, latitude: 51.47,
  longitude: 0.29, sog: 3, cog: 90, heading: null }, 9000);
vessel = renderer.vessels.get('235093883');
assert.equal(vessel.kind, 'B');
assert.equal(vessel.trail.length, 2, 'real movement appends a trail point');

renderer.mergeMessage({ type: 4, mmsi: 2320001, base_station: true, latitude: 51.5,
  longitude: 0.1 }, 9500);
assert.equal(renderer.vessels.get('002320001').kind, 'base');
renderer.mergeMessage({ type: 21, mmsi: 992351000, aid_to_navigation: true, aid_type: 20,
  name: 'NORE SWATCH', latitude: 51.48, longitude: 0.8 }, 9600);
assert.equal(renderer.vessels.get('992351000').kind, 'aton');
assert.equal(renderer.vesselKindText(renderer.vessels.get('992351000')),
  'AtoN: Cardinal mark N');
assert.equal(renderer.positionedVessels().length, 3);

console.log('AIS map decoder and state tests passed');
