import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/adsb_map.js', import.meta.url), 'utf8');
const sandbox = { console };
vm.runInNewContext(source, sandbox, { filename: 'adsb_map.js' });
const {
  normalizeIcao, trueCourse, altitudeColor, haversineKm, bearingDegrees,
  destinationPoint, localStyle, graticuleGeoJson, AdsbMapRenderer,
} = sandbox.__grAdsbMapInternals;

assert.equal(normalizeIcao(' a02c40 '), 'A02C40');
assert.equal(normalizeIcao('<script>'), '', 'invalid decoder identities cannot become DOM keys');
assert.equal(trueCourse(0), 90, 'the decoder Cartesian east heading becomes true course 090');
assert.equal(trueCourse(90), 0, 'the decoder Cartesian north heading becomes true course 000');
assert.equal(trueCourse(-90), 180, 'the decoder Cartesian south heading becomes true course 180');
assert.equal(trueCourse(180), 270, 'the decoder Cartesian west heading becomes true course 270');
assert.equal(trueCourse(null), null);

assert.notEqual(altitudeColor(4000), altitudeColor(16000));
assert.notEqual(altitudeColor(16000), altitudeColor(36000));
assert.equal(altitudeColor(Number.NaN), '#aab7c7');

const washingtonToBaltimore = haversineKm(38.9072, -77.0369, 39.2904, -76.6122);
assert.ok(washingtonToBaltimore > 50 && washingtonToBaltimore < 70);
const bearing = bearingDegrees(38.9072, -77.0369, 39.2904, -76.6122);
assert.ok(bearing > 30 && bearing < 60);
const oneHundredKmNorth = destinationPoint(40, -75, 0, 100);
assert.ok(oneHundredKmNorth[1] > 40.8 && oneHundredKmNorth[1] < 41);
assert.ok(Math.abs(oneHundredKmNorth[0] + 75) < 0.01);

assert.equal(localStyle().version, 8);
assert.ok(graticuleGeoJson().features.length >= 20,
  'the offline fallback retains geographic reference lines');

// Exercise the renderer's decoder-state merge without constructing browser DOM.
const renderer = Object.create(AdsbMapRenderer.prototype);
renderer.aircraft = new Map();
renderer.showReceiver = false;
renderer.receiverLatitude = 0;
renderer.receiverLongitude = 0;
renderer.mergeAircraft({
  icao: 'a02c40', callsign: 'TEST123 ', latitude: 38.5, longitude: -77.2,
  altitude: 15600, speed: 341.696, heading: -33.7831,
  vertical_rate: -2048, num_msgs: 2, df: 17, snr: 21.9412,
}, 1000);
let aircraft = renderer.aircraft.get('A02C40');
assert.equal(aircraft.callsign, 'TEST123');
assert.equal(aircraft.altitude, 15600);
assert.ok(Math.abs(aircraft.course - 123.7831) < 1e-6);
assert.deepEqual(JSON.parse(JSON.stringify(aircraft.trail)), [
  { latitude: 38.5, longitude: -77.2, receivedAt: 1000 },
]);

renderer.mergeAircraft({ icao: 'a02c40', latitude: null, longitude: null,
  altitude: null, num_msgs: 3 }, 1250);
aircraft = renderer.aircraft.get('A02C40');
assert.equal(aircraft.latitude, 38.5,
  'an absent field in a later cumulative PDU does not erase a usable position');
assert.equal(aircraft.altitude, 15600);
assert.equal(aircraft.num_msgs, 3);
assert.equal(aircraft.trail.length, 1,
  'stationary/coalesced updates do not grow trails');

renderer.mergeAircraft({ icao: 'a02c40', latitude: 38.51, longitude: -77.19 }, 2200);
aircraft = renderer.aircraft.get('A02C40');
assert.equal(aircraft.trail.length, 2, 'meaningful movement appends a trail point');

console.log('ADS-B map numerical and state tests passed');
