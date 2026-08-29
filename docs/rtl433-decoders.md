# Plan for porting rtl_433 decoders

A repeatable path from one rtl_433 device decoder and its upstream regression
capture to a browser flowgraph. Read [blocks.md](blocks.md),
[js-blocks.md](js-blocks.md), and [flowgraph-files.md](flowgraph-files.md) first.
Read [recording-viewer.md](recording-viewer.md) too when the example reads a
capture.

A decoder consumes IQ or a demodulated stream and publishes one
PMT dictionary for every accepted transmission. JSON is test-fixture and
presentation syntax, not the decoder's runtime interface.

IQ captures are never committed to this repository. Publish the selected
upstream sample as a GNU Radio World SigMF recording and use its stable
recording key in both the example and the end-to-end test. This keeps binary
fixtures out of Git while putting the recording behind the Range/CORS behavior
the runner controls and making its datatype, sample rate, frequency, provenance,
and viewer available to users.

## 1. Pin both upstream revisions and select the regression case

Record exact commit hashes for `merbanan/rtl_433` and
`merbanan/rtl_433_tests`; do not build against moving branch heads. Locate:

- the device implementation under `rtl_433/src/devices/`;
- the matching directory under `rtl_433_tests/tests/`;
- one small capture that exercises meaningful decoded fields;
- the companion `.json` containing the expected result. Not all captures have
  one; if none does, ask whether to continue before inventing an oracle.

Copy only the small companion JSON, without modification, into
`test/fixtures/rtl433/<device>/`. Do not copy the IQ capture into the repository.
Document the upstream paths and revisions, immutable upstream URLs, original
recording format, byte length, sample rate, center frequency, SHA-256 checksums,
and the GNU Radio World recording key in that directory's README. The JSON
remains the source of truth for expected values; do not infer them from the
decoder.

Download the capture only into a temporary directory or an explicitly
git-ignored cache while preparing and testing the port. Before continuing, check
that neither the capture nor the resulting `.sigmf-data` is tracked or staged.

## 2. Publish it as a GNU Radio World SigMF recording

Create a SigMF pair for the selected upstream sample and upload both objects to
the `gnuradio-wasm-recordings` R2 bucket under a stable key such as
`rtl433/<device>/<capture>`; follow [recording-viewer.md](recording-viewer.md).
For an rtl_433 `.cu8` capture, the `.sigmf-data` payload should be byte-for-byte
identical to the upstream file: this is metadata packaging, not sample-value
conversion. Set at least:

- `core:datatype` to the actual source representation (`cu8` for `.cu8`);
- `core:sample_rate` and the capture's `core:frequency` from the upstream
  filename or documentation;
- a description and catalog fields that identify the device and rtl_433;
- the pinned `rtl_433_tests` revision, upstream path/URL, original filename,
  byte length, and SHA-256 in the metadata provenance.

After upload, verify that the pair appears in the recording index, that the data
object's SHA-256 is the documented value, and that a one-byte request returns
`206` with a matching `Content-Range`. Do not add either SigMF object to this
repository. Treat replacement of an object at that key as a fixture change:
update its checksum and expected JSON in the same reviewed change.

## 3. Trace the complete rtl_433 pipeline

The device file's `decode_fn` is only the payload tail. Its `r_device` also
selects a modulation/slicer and declares widths, tolerances, gap/reset limits,
and sometimes sync behavior. Before writing code, trace:

1. input formatting and envelope/FM processing in `baseband.c`;
2. burst and pulse extraction in `pulse_detect.c` or the FSK detector;
3. the selected function in `pulse_slicer.c`;
4. bitbuffer transforms and repeat-row selection;
5. every length, sanity, checksum, MIC, and false-positive rejection in the
   device decoder;
6. every output field and its `DATA_STRING`, `DATA_INT`, or `DATA_DOUBLE` type.

Write these facts into the block documentation with the pinned rtl_433 revision.
Preserve boundary inequalities, integer truncation when microseconds become
samples, and state across scheduler `work()` calls. A port that recognizes one
known payload but omits the upstream rejection path is not complete.

## 4. Choose reusable block boundaries

Keep recording-format conversion separate from protocol decoding:

```text
GR World SigMF recording -> format adapter -> protocol decoder -> PMT dictionary
live SDR complex IQ      -----------------> protocol decoder -> PMT dictionary
```

For example, a shared CU8 adapter restores each byte's unsigned value, removes
the 128 bias, forms normalized complex samples, and decimates the interleaved
byte stream by two. Protocol decoders then accept ordinary complex samples, so
the same block works with a live SDR and a regression capture.

Prefer a repository JavaScript block when the decoder is synchronous stream DSP
with modest state. Use C++ under `blocks/src/` when it needs a native library or
a shared native framework would materially simplify several ports. Needing PMT
message output alone is not a reason to leave JavaScript.

Extract a common pulse/demodulation block only after multiple ports prove that
their state machines and boundaries are genuinely identical. Similar timing
parameters do not by themselves make slicers interchangeable.

## 5. Define the PMT output contract

Give each decoder a message output named `out` unless the upstream protocol has
a meaningful reason for more than one. Publish a PMT dictionary that mirrors
rtl_433's decoded data object:

- keys are interned symbols using the exact rtl_433 field names;
- values follow the upstream `data_make()` declarations: `DATA_STRING` uses the
  JavaScript message bridge's documented PMT string representation, `DATA_INT`
  becomes a PMT integer, and `DATA_DOUBLE` becomes a PMT real;
- values remain machine-readable and retain upstream units and scale;
- presentation formatting and JSON serialization belong downstream;
- capture/test-harness metadata such as a fixture's `time` field is not
  synthesized by the decoder.

Keep an expected-field schema beside the test, derived from the upstream
`data_make()` call. JSON does not distinguish an integer from a real whose
current value happens to be `0`, so the test must not infer PMT types from parsed
values alone.

## 6. Add block metadata and regenerate

Add the implementation and its authoritative `.block.yml`:

- JavaScript: `blocks/js/rtl433_<device>.js` and
  `blocks/grc/rtl433_<device>.block.yml` with `flags: [js]`;
- C++: the appropriate `blocks/src/` implementation and GRC metadata, following
  the normal block/factory placement rule.

The metadata owns the palette label, documentation, parameters, and stream and
message ports. The implementation's descriptor must agree with it. Then run:

```bash
python3 runner/gen_registry.py
python3 editor/gen/gen_blocklib.py editor/public/blocks.json
cmake -S runner -B runner/build
cmake --build runner/build
(cd editor && npm run build)
```

Adding a repository JavaScript block relinks because its ID is compiled into the
generated map. Editing an existing block needs the build's source-copy step;
metadata or descriptor changes also need regeneration.

## 7. Test the hosted recording against the companion JSON

Extend the existing runtime suite rather than creating a new suite per decoder.
The value test must:

1. read the hosted GNU Radio World recording identified by the documented key;
2. pass it through the real shipped format adapter and decoder in multiple work
   calls, so state across scheduler boundaries is exercised;
3. capture the PMT dictionary emitted on `out`;
4. parse the companion JSON and remove only documented harness fields such as
   `time`;
5. convert the remaining expected fields through the decoder's expected-field
   schema;
6. compare the complete PMT dictionary, including keys, PMT types, and values;
7. assert the expected message count so duplicates and false positives fail.

Do not stringify the PMT for comparison. Text equality can hide a wrong PMT
type, and log output is not a substitute for testing the message interface.

After the focused value test passes, rebuild and run the JavaScript end-to-end
suite and the full smoke suite.

Fetch the recording by the documented key, not from a repository fixture. Verify its byte
length and SHA-256 before decoding, and use a temporary file or test-local HTTP
binding if the focused harness needs a local path. A missing recording, checksum
mismatch, or server without working byte ranges is a hard test failure. The
test is therefore network-dependent; do not silently skip it or fall back to an
unverified moving URL.

## 8. Add and run the example flowgraph

Add `example_flowgraphs/rtl_433/<device>.grc` using the same hosted recording.
Use GR World Recording rather than Public HTTP Recording so the example uses
the stable catalog key, derives its type from SigMF, and gets the recording
viewer. The normal path is:

```text
GR World Recording (byte) -> format adapter -> Throttle -> decoder
decoder (out message) -> Message Debug
```

Set the recording type and sample rate from its filename/metadata, pace file
playback with `blocks_throttle2`, connect every required port, and state the
expected decoded fields in the flowgraph description. Message Debug makes the
typed PMT result visible without changing the decoder interface.

Auto-arrange and run every new example through the editor:

```bash
node scripts/arrange_example.mjs rtl_433/<device>.grc
node scripts/run_example.mjs rtl_433/<device>.grc 8090 25 \
  --expect='<distinctive expected field or value>'
```

The editor path is mandatory: it catches parameter-schema, expression, and port
validation failures that a runner-only test skips.

## Definition of done

- Upstream source and test revisions are pinned and documented.
- No IQ capture or `.sigmf-data` is tracked by this repository.
- The byte-identical recording is hosted as a GNU Radio World SigMF pair with
  provenance, a stable key, and a verified checksum; only the companion JSON is
  committed as the expected-value fixture.
- The full demodulator, slicer, validation, and payload path is represented.
- The decoder publishes a typed PMT dictionary, never console-only JSON.
- The real-IQ test compares every decoder-owned field and rejects duplicates.
- Block metadata, generated registration, and the palette agree.
- The example is auto-arranged and passes through the actual editor.
- Focused runtime tests, editor checks, end-to-end tests, and smoke tests pass.

## List of decoders with a .json

abmt.c (Basics-Meat)
acurite.c (Acurite-00275rm, Acurite-00276rm, Acurite-3n1, Acurite-515,
  Acurite-590TX, Acurite-5n1, Acurite-6045M, Acurite-606TX,
  Acurite-609TXC, Acurite-985, Acurite-986, Acurite-Atlas,
  Acurite-Optimus, Acurite-Rain899, Acurite-Tower)
akhan_100F14.c (Akhan-100F14)
alecto.c (AlectoV1-Rain, AlectoV1-Temperature, AlectoV1-Wind)
alps_fwb1u545.c (Alps-FWB1U545)
ambient_weather.c (Ambientweather-F007TH)
ambientweather_tx8300.c (AmbientWeather-TX8300)
ambientweather_wh31e.c (AmbientWeather-WH31B, AmbientWeather-WH31E,
  EcoWitt-WH40, EcoWitt-WN20)
arad_ms_meter.c (AradMsMeter-Dialog3G)
astrostart_2000.c (Astrostart-2000)
audiovox_pro_oe3b.c (Audiovox-PROOE3B)
auriol_aft77b2.c (Auriol-AFT77B2)
auriol_afw2a1.c (Auriol-AFW2A1)
auriol_ahfl.c (Auriol-AHFL)
auriol_hg02832.c (Auriol-HG02832)
baldr_therm.c (Baldr-E0666TH)
blueline.c (Blueline-PowerCost)
blyss.c (Blyss-DC5ukwh)
bm5.c (BM5-v2)
brennenstuhl_rcs_2044.c (Brennenstuhl-RCS2044)
bresser_3ch.c (Bresser-3CH)
bresser_5in1.c (Bresser-5in1)
bresser_6in1.c (Bresser-6in1)
bresser_garden.c (Bresser-Gateway, Bresser-SoilMoisture, Bresser-WaterTimer)
bresser_st1005h.c (Bresser-ST1005H)
burnhardbbq.c (BurnhardBBQ)
calibeur.c (Calibeur-RF104)
cardin.c (Cardin-S466)
cavius.c (Cavius-Door, Cavius-Security)
celsia_czc1.c (Celsia-CZC1)
chamberlain_cwpirc.c (Chamberlain-CWPIRC)
chrysler_car_remote.c (Chrysler-CarRemote)
chuango.c (Chuango-Security)
cmr113.c (Clipsal-CMR113)
code_alarm_car_remote.c (CodeAlarm-FRDPC2002)
companion_wtr001.c (Companion-WTR001)
compustar_1wg3r.c (Compustar-1WG3R)
continental_car_remote.c (Continental-KR5V2X)
cotech_36_7900.c (Cotech-367900)
cotech_36_7959.c (Cotech-367959)
ctt_life_power_hybrid.c (CTT-Tag)
current_cost.c (CurrentCost-Counter, CurrentCost-EnviR, CurrentCost-TX)
danfoss.c (Danfoss-CFR)
deltadore_x3d.c (DeltaDore-X3D)
dickert_mahs.c (Dickert-MAHS433)
digitech_xc0324.c (Digitech-XC0324)
directv.c (DirecTV-RC66RX)
dish_remote_6_3.c (Dish-RC63)
dsc.c (DSC-Security)
ec3k.c (Voltcraft-EC3k)
ecoeye.c (EcoEye)
ecowitt.c (Ecowitt-WH53)
efergy_e2_classic.c (Efergy-e2CT)
efergy_optical.c (Efergy-Optical)
efth800.c (Eurochron-EFTH800)
elero.c (Elero)
elro_db286a.c (Elro-DB286A)
elsner_solexa.c (Elsner-Solexa)
elster_power_meter.c (Elster-PowerMeter2)
emax.c (Altronics-X7064, Emax-W6)
emontx.c (emonTx-Energy)
en2058.c (EN2058)
ert_idm.c (IDM, NETIDM)
ert_scm.c (ERT-SCM)
esa.c (ESAx000WZ)
esic_emt7110.c (ESIC-EMT7110)
esperanza_ews.c (Esperanza-EWS)
esun_en2053.c (Esun-EN2053)
eurochron.c (Eurochron-TH)
fineoffset.c (Alecto-WS1200v1, Alecto-WS1200v2,
  Fineoffset-TelldusProove, Fineoffset-WH0290, Fineoffset-WH0530,
  Fineoffset-WH2, Fineoffset-WH24, Fineoffset-WH25, Fineoffset-WH2A,
  Fineoffset-WH32, Fineoffset-WH32B, Fineoffset-WH5, Fineoffset-WH51,
  Fineoffset-WH65B, Rosenborg-66796)
fineoffset_wh1050.c (Fineoffset-WH1050, TFA-303151)
fineoffset_wh1080.c (Fineoffset-WHx080)
fineoffset_wh52.c (Fineoffset-WH52)
fineoffset_wn34.c (Fineoffset-WN34, Fineoffset-WN38)
fineoffset_ws90.c (Fineoffset-WS90)
florabest.c (Florabest-FBTH1)
flowis.c (Flowis)
fordremote.c (Ford-CarRemote)
fsl_scoreboard.c (FSL-Scoreboard)
ft004b.c (FT-004B)
funkbus.c (Funkbus-Remote)
ge_coloreffects.c (GE-ColorEffects)
geevon.c (Geevon-TX163)
geevon_tx19.c (Geevon-TX191)
generic_motion.c (Generic-Motion)
generic_remote.c (Generic-Remote)
generic_temperature_sensor.c (Generic-Temperature)
gm_car_remote.c (GM-ABO1502T)
govee_h5059.c (Govee-H5059)
govee_h5112.c (Govee-H5112)
govee_h5310.c (Govee-H5310)
gridstream.c (LandisGyr-GS)
gt_tmbbq05.c (GT-TMBBQ05)
gt_wt_02.c (GT-WT02)
gt_wt_03.c (GT-WT03)
hanwell_ml4000.c (Hanwell-ML4000)
hcs200.c (Microchip-HCS200)
hcs361.c (Microchip-HCS361)
hcs362.c (Microchip-HCS362)
hideki.c (Hideki-Rain, Hideki-TS04, Hideki-Temperature, Hideki-Wind)
holman_ws5029.c (Holman-WS5029)
hondaremote.c (Honda-CarRemote)
honeywell.c (Honeywell-Security)
honeywell_cm921.c (Honeywell-CM921)
honeywell_wdb.c (Honeywell-ActivLink)
ht680.c (HT680-Remote)
ibis_beacon.c (IBIS-Beacon)
ikea_sparsnas.c (Ikea-Sparsnas)
infactory.c (inFactory-TH)
inkbird_ith20r.c (Inkbird-ITH20R)
insteon.c (Insteon)
interlogix.c (Interlogix-Security)
intertechno.c (Intertechno-Remote)
kedsum.c (Kedsum-TH)
kerui.c (Kerui-Security)
kidde_smoke.c (Kidde-Smoke)
klimalogg.c (Klimalogg-Pro)
lacrosse.c (LaCrosse-TX)
lacrosse_breezepro.c (LaCrosse-BreezePro)
lacrosse_r1.c (LaCrosse-R1, LaCrosse-W1)
lacrosse_th3.c (LaCrosse-TH2, LaCrosse-TH3)
lacrosse_tx141x.c (LaCrosse-TX141Bv2, LaCrosse-TX141Bv3,
  LaCrosse-TX141THBv2, LaCrosse-TX141W)
lacrosse_tx22uit.c (LaCrosse-TX22UIT)
lacrosse_tx31u.c (LaCrosse-TX31UIT)
lacrosse_tx34.c (LaCrosse-TX34IT)
lacrosse_tx35.c (LaCrosse-TX29IT, LaCrosse-TX35DTHIT)
lacrosse_wr1.c (LaCrosse-WR1)
lacrosse_ws6868.c (LaCrosse-TX231RW, LaCrosse-TX232TH)
lacrosse_ws7000.c (LaCrosse-WS250019, LaCrosse-WS700015,
  LaCrosse-WS700016, LaCrosse-WS700020, LaCrosse-WS700022,
  LaCrosse-WS700027)
lacrossews.c (LaCrosse-WS2310, LaCrosse-WS3600)
lightwave_rf.c (Lightwave-RF)
m_bus.c (KNX-RF, Wireless-MBus)
martec_mplcd.c (Martec-MPLCD)
maverick_et73.c (Maverick-ET73)
maverick_et73x.c (Maverick-ET73x)
mic6sc2_car_remote.c (MIC6SC2-CarRemote)
missil_ml0757.c (Missil-ML0757)
neptune_r900.c (Neptune-R900)
newkaku.c (KlikAanKlikUit-Switch)
nexa.c (Nexa-Security)
nexus.c (Nexus-T, Nexus-TH)
nidec_car_remote.c (Nidec-OUCG8D)
norgo.c (Norgo-NGE101)
oil_smart.c (Oil-Ultrasonic)
oil_standard.c (Oil-SonicStd)
oil_watchman.c (Oil-SonicSmart)
oil_watchman_advanced.c (Oil-SonicAdv)
omni.c (Omni-Multisensor)
opus_xt300.c (Opus-XT300)
oregon_scientific.c (Oregon-AWR129, Oregon-BHTR968, Oregon-BTHGN129,
  Oregon-BTHR918, Oregon-CM130, Oregon-CM160, Oregon-CM180,
  Oregon-RTGN318, Oregon-RTHN129, Oregon-THGR122N, Oregon-THN129,
  Oregon-THN132N, Oregon-UVR128, Oregon-WGR800, Oregon-WGR968)
oregon_scientific_sl109h.c (Oregon-SL109H)
oregon_scientific_v1.c (Oregon-v1)
oregon_scientific_wmr500.c (Oregon-WMR500)
oria_wa150km.c (Oria-WA150KM)
philips_aj3650.c (Philips-Temperature)
philips_aj7010.c (Philips-AJ7010)
prologue.c (Prologue-TH)
proove.c (Proove-Security)
quhwa.c (Quhwa-Doorbell)
radiohead_ask.c (RadioHead-ASK, SensibleLiving-Moisture)
revolt_nc5462.c (Revolt-NC5462)
rftech.c (RF-tech)
rfxmeter.c (RfxMeter)
rubicson.c (Rubicson-Temperature)
rubicson_48659.c (Rubicson-48659)
rubicson_pool_48942.c (Rubicson-48942)
s3318p.c (Conrad-S3318P)
schou_72543_rain.c (Schou-72543)
schraeder.c (Schrader, Schrader-EG53MA4, Schrader-MRXBC5A4,
  Schrader-NIS315G3, Schrader-SMD3MA4)
scmplus.c (SCMplus)
secplus_v1.c (Secplus-v1)
secplus_v2.c (Secplus-v2)
sharp_spc775.c (Sharp-SPC775)
shenzhen_wale_wl_th6r.c (WL-TH6R)
siemens_5wy72xx.c (Siemens-5WY72XX)
silver_spring_mesh.c (SilverSpring-Mesh)
silvercrest.c (Silvercrest-Remote)
simplisafe.c (SimpliSafe-Keypad, SimpliSafe-Sensor)
smoke_gs558.c (Smoke-GS558)
solight_te44.c (Solight-TE44)
somfy_rts.c (Somfy-RTS)
springfield.c (Springfield-Soil)
steelmate.c (Steelmate)
tfa_14_1504_v2.c (TFA-141504v2)
tfa_30_3196.c (TFA-303196)
tfa_30_3307.c (TFA-303307)
tfa_drop_30.3233.c (TFA-Drop)
tfa_marbella.c (TFA-Marbella)
tfa_pool_thermometer.c (TFA-Pool)
tfa_twin_plus_30.3049.c (TFA-TwinPlus)
thermopro_tp11.c (Thermopro-TP11)
thermopro_tp12.c (Thermopro-TP12)
thermopro_tp211b.c (ThermoPro-TP211B)
thermopro_tp28b.c (ThermoPro-TP28b)
thermopro_tp86xb.c (ThermoPro-TempSpikeXR)
thermopro_tx2.c (Thermopro-TX2)
thermopro_tx2c.c (Thermopro-TX2C)
thermor.c (Thermor-DG950)
thermor_a6n_132tx.c (Thermor-A6N132TX)
tpms_abarth124.c (Abarth-124Spider, Shenzhen-EGQQ85)
tpms_bmw.c (BMW-GEN5)
tpms_citroen.c (Citroen)
tpms_eezrv.c (EezTire-E618)
tpms_elantra2012.c (Elantra2012)
tpms_ford.c (Ford)
tpms_gear_hive.c (Gear-Hive)
tpms_gm.c (GM-Aftermarket)
tpms_honda.c (Honda-TRW)
tpms_imars_t240.c (iMars-T240)
tpms_jansite.c (Jansite)
tpms_jansite_solar.c (Jansite-Solar)
tpms_jeep.c (Jeep)
tpms_mercedes_benz.c (MercedesBenz-Sprinter)
tpms_nissan.c (Nissan)
tpms_pmv107j.c (PMV-107J)
tpms_renault.c (Renault)
tpms_sefis_m3.c (Sefis-M3)
tpms_smartire.c (SmarTire-AM)
tpms_toyota.c (Toyota)
tpms_truck.c (Truck)
tpms_tyreguard400.c (TyreGuard400)
tr_502msv.c (TR-502MSV)
ts_ft002.c (TS-FT002)
ttx201.c (Emos-TTX201)
twogig_key2e.c (TwoGig-KEY2E345)
typhur_sync_gold.c (Typhur-SyncGold)
vaillant_vrt340f.c (Vaillant-VRT340f)
vauno_en8822c.c (Vauno-EN8822C)
visonic_powercode.c (Visonic-Powercode)
vivint.c (Vivint-Security)
wallarge_cltx001.c (WallarGe-CLTX001)
watts_thermostat.c (Watts-WFHTRF)
watts_vision.c (Watts-Vision)
watts_wfht_rf.c (Watts-WFHTLCDRF)
waveman.c (Waveman-Switch)
wg_pb12v1.c (WG-PB12V1)
wssensor.c (Hyundai-WS)
wt0124.c (WT0124-Pool)
wt450.c (WT450-TH)
x10_rf.c (X10-RF)
x10_sec.c (X10-Security)