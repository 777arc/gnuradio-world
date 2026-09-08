// Browser-native map for wasm_adsb_map_sink. The GNU Radio block sends compact
// JSON batches; this file owns aircraft state, MapLibre, interaction, rendering,
// and semantic GUI observation.
(() => {
  'use strict';

  const MAX_AIRCRAFT = 1024;
  const MAX_TRAIL_POINTS = 180;
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

  function normalizeIcao(value) {
    const text = String(value || '').trim().toUpperCase();
    return /^[0-9A-F]{1,16}$/.test(text) ? text : '';
  }

  function trueCourse(heading) {
    const value = numeric(heading);
    return value == null ? null : (90 - value % 360 + 360) % 360;
  }

  function altitudeColor(altitude) {
    const feet = numeric(altitude);
    if (feet == null) return '#aab7c7';
    if (feet < 5000) return '#67e8a5';
    if (feet < 15000) return '#b9e769';
    if (feet < 25000) return '#ffd166';
    if (feet < 35000) return '#ff9f68';
    if (feet < 45000) return '#d68cff';
    return '#ff79c6';
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
        id: 'gr-adsb-background', type: 'background',
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

  let mapLibrePromise = null;
  function loadMapLibre() {
    if (mapLibrePromise) return mapLibrePromise;
    const moduleUrl = new URL(`${MAPLIBRE_DIRECTORY}/maplibre-gl.mjs`, location.href);
    const workerUrl = new URL(`${MAPLIBRE_DIRECTORY}/maplibre-gl-worker.mjs`, location.href);
    if (globalThis.__grBuildStamp) {
      moduleUrl.searchParams.set('v', globalThis.__grBuildStamp);
      workerUrl.searchParams.set('v', globalThis.__grBuildStamp);
    }
    mapLibrePromise = import(moduleUrl.href).then(module => {
      module.setWorkerUrl(workerUrl.href);
      return module;
    });
    return mapLibrePromise;
  }

  class AdsbMapRenderer {
    constructor(id, options) {
      this.id = id;
      this.blockName = String(options.blockName || `adsb_map_${id}`);
      this.title = String(options.title || 'ADS-B Map');
      this.basemap = ['light', 'dark', 'none'].includes(options.basemap)
        ? options.basemap : 'light';
      this.units = options.units === 'metric' ? 'metric' : 'aviation';
      this.showReceiver = !!options.showReceiver;
      this.receiverLatitude = clamp(numeric(options.receiverLatitude) ?? 0, -90, 90);
      this.receiverLongitude = clamp(numeric(options.receiverLongitude) ?? 0, -180, 180);
      this.showLabels = options.showLabels !== false;
      this.showTrails = true;
      this.trailSeconds = Math.max(0, numeric(options.trailSeconds) ?? 300);
      this.staleSeconds = Math.max(1, numeric(options.staleSeconds) ?? 15);
      this.expireSeconds = Math.max(this.staleSeconds + 1,
        numeric(options.expireSeconds) ?? 60);
      this.aircraft = new Map();
      this.selectedIcao = '';
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
      this.root.className = 'gr-adsb-map';
      this.root.dataset.blockName = this.blockName;
      this.root.dataset.blockId = 'wasm_adsb_map_sink';
      this.root.setAttribute('aria-label', `${this.title} ADS-B aircraft map`);
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
      this.fitButton = makeButton('Fit all', 'fit', 'Fit every positioned aircraft');
      this.homeButton = makeButton('Home', 'home', 'Center the receiver or fit all aircraft');
      this.followButton = makeButton('Follow', 'follow', 'Follow the selected aircraft');
      this.labelsButton = makeButton('Labels', 'labels', 'Show or hide aircraft labels');
      this.trailsButton = makeButton('Trails', 'trails', 'Show or hide recent flight trails');
      this.toolbar.append(this.titleElement, this.fitButton, this.homeButton,
        this.followButton, this.labelsButton, this.trailsButton);

      this.content = document.createElement('div');
      Object.assign(this.content.style, {
        minHeight: '0', flex: '1 1 auto', display: 'flex', overflow: 'hidden',
      });
      this.mapHost = document.createElement('div');
      this.mapHost.className = 'gr-adsb-map-surface';
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
      this.overlay.className = 'gr-adsb-aircraft-overlay';
      this.overlay.setAttribute('aria-label', 'Decoded ADS-B aircraft positions');
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
      this.search.placeholder = 'Search callsign or ICAO';
      this.search.setAttribute('aria-label', 'Search aircraft');
      Object.assign(this.search.style, {
        margin: '7px', padding: '6px 8px', border: '1px solid #38516c',
        borderRadius: '4px', background: '#07121f', color: '#e9f2fd', font: UI_FONT,
      });
      this.list = document.createElement('div');
      this.list.className = 'gr-adsb-aircraft-list';
      Object.assign(this.list.style, {
        minHeight: '70px', flex: '1 1 auto', overflow: 'auto',
        borderTop: '1px solid #263c54', borderBottom: '1px solid #263c54',
      });
      this.details = document.createElement('div');
      this.details.className = 'gr-adsb-aircraft-details';
      this.details.textContent = 'Select an aircraft';
      Object.assign(this.details.style, {
        flex: '0 0 auto', maxHeight: '48%', overflow: 'auto', padding: '8px',
        boxSizing: 'border-box', color: '#afc1d5', font: UI_MONO_FONT,
      });
      this.side.append(this.search, this.list, this.details);
      this.content.append(this.mapHost, this.side);

      this.status = document.createElement('div');
      this.status.className = 'gr-adsb-map-status';
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
          this.followSelected = !!this.selectedIcao && !this.followSelected;
          this.followAircraft();
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
        const row = event.target?.closest?.('[data-icao]');
        if (row) this.select(row.dataset.icao);
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
          zoom: this.showReceiver ? 7 : 1.25,
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
        console.error(`ADS-B Map: ${error?.message || error}`);
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
      addSource('gr-adsb-graticule', graticuleGeoJson());
      addSource('gr-adsb-trails', emptyFeatures());
      addSource('gr-adsb-rings', emptyFeatures());
      addSource('gr-adsb-receiver', emptyFeatures());
      if (!this.map.getLayer('gr-adsb-graticule-line')) {
        this.map.addLayer({ id: 'gr-adsb-graticule-line', type: 'line',
          source: 'gr-adsb-graticule', paint: {
            'line-color': this.basemap === 'light' ? '#71889a' : '#54708a',
            'line-width': 0.7, 'line-opacity': this.basemap === 'none' ? 0.45 : 0.18,
          } });
      }
      if (!this.map.getLayer('gr-adsb-trail-line')) {
        this.map.addLayer({ id: 'gr-adsb-trail-line', type: 'line',
          source: 'gr-adsb-trails', paint: {
            'line-color': ['coalesce', ['get', 'color'], '#67d5ff'],
            'line-width': 2, 'line-opacity': 0.72,
          } });
      }
      if (!this.map.getLayer('gr-adsb-ring-line')) {
        this.map.addLayer({ id: 'gr-adsb-ring-line', type: 'line',
          source: 'gr-adsb-rings', paint: {
            'line-color': '#68d6e8', 'line-width': 1,
            'line-dasharray': [3, 3], 'line-opacity': 0.65,
          } });
      }
      if (!this.map.getLayer('gr-adsb-receiver-dot')) {
        this.map.addLayer({ id: 'gr-adsb-receiver-dot', type: 'circle',
          source: 'gr-adsb-receiver', paint: {
            'circle-radius': 5, 'circle-color': '#ffffff',
            'circle-stroke-width': 2, 'circle-stroke-color': '#17c9dc',
          } });
      }
    }

    update(rawBatch) {
      let batch;
      try { batch = typeof rawBatch === 'string' ? JSON.parse(rawBatch) : rawBatch; }
      catch (error) {
        console.warn(`ADS-B Map ignored invalid update JSON: ${error?.message || error}`);
        return;
      }
      if (!Array.isArray(batch)) return;
      const now = performance.now();
      for (const raw of batch) this.mergeAircraft(raw, now);
      this.updateMapData();
      this.rebuildList();
      this.updateDetails();
      this.updateStatus();
      if (!this.hasInitialFit && this.positionedAircraft().length) {
        this.hasInitialFit = true;
        setTimeout(() => this.fitAll(), 0);
      }
      this.followAircraft();
      this.dirty = true;
    }

    mergeAircraft(raw, now) {
      const icao = normalizeIcao(raw?.icao);
      if (!icao) return;
      if (!this.aircraft.has(icao) && this.aircraft.size >= MAX_AIRCRAFT) {
        const oldest = [...this.aircraft.values()]
          .sort((left, right) => left.receivedAt - right.receivedAt)[0];
        if (oldest) this.aircraft.delete(oldest.icao);
      }
      const previous = this.aircraft.get(icao) || { icao, trail: [] };
      const next = { ...previous, receivedAt: now };
      const callsign = String(raw?.callsign || '').trim();
      if (callsign) next.callsign = callsign;
      const datetime = String(raw?.datetime || '').trim();
      if (datetime) next.datetime = datetime;
      for (const name of ['altitude', 'speed', 'heading', 'vertical_rate',
        'latitude', 'longitude', 'num_msgs', 'timestamp', 'df', 'snr']) {
        const value = numeric(raw?.[name]);
        if (value != null) next[name] = value;
      }
      next.course = trueCourse(next.heading);
      next.color = altitudeColor(next.altitude);
      const positioned = Number.isFinite(next.latitude) && Number.isFinite(next.longitude) &&
        Math.abs(next.latitude) <= 90 && Math.abs(next.longitude) <= 180;
      if (positioned) {
        const last = next.trail[next.trail.length - 1];
        const distance = last
          ? haversineKm(last.latitude, last.longitude, next.latitude, next.longitude) : null;
        if (!last || distance >= 0.05 || now - last.receivedAt >= 1000) {
          next.trail = [...next.trail, { latitude: next.latitude,
            longitude: next.longitude, receivedAt: now }].slice(-MAX_TRAIL_POINTS);
        }
      }
      this.aircraft.set(icao, next);
    }

    positionedAircraft() {
      return [...this.aircraft.values()].filter(aircraft =>
        Number.isFinite(aircraft.latitude) && Number.isFinite(aircraft.longitude));
    }

    housekeeping() {
      const now = performance.now();
      let removed = false;
      for (const [icao, aircraft] of this.aircraft) {
        if (now - aircraft.receivedAt > this.expireSeconds * 1000) {
          this.aircraft.delete(icao);
          if (this.selectedIcao === icao) {
            this.selectedIcao = '';
            this.followSelected = false;
          }
          removed = true;
        } else {
          aircraft.trail = aircraft.trail.filter(point =>
            now - point.receivedAt <= this.trailSeconds * 1000);
        }
      }
      if (removed || this.aircraft.size) {
        this.updateMapData();
        this.rebuildList();
        this.updateDetails();
        this.updateStatus();
        this.dirty = true;
      }
    }

    receiverDistance(aircraft) {
      if (!this.showReceiver) return null;
      return haversineKm(this.receiverLatitude, this.receiverLongitude,
        aircraft.latitude, aircraft.longitude);
    }

    receiverBearing(aircraft) {
      if (!this.showReceiver) return null;
      return bearingDegrees(this.receiverLatitude, this.receiverLongitude,
        aircraft.latitude, aircraft.longitude);
    }

    updateMapData() {
      if (!this.styleReady || !this.map?.isStyleLoaded()) return;
      this.ensureMapLayers();
      const now = performance.now();
      const trailFeatures = [];
      if (this.showTrails && this.trailSeconds > 0) {
        for (const aircraft of this.positionedAircraft()) {
          const coordinates = aircraft.trail
            .filter(point => now - point.receivedAt <= this.trailSeconds * 1000)
            .map(point => [point.longitude, point.latitude]);
          if (coordinates.length > 1) trailFeatures.push({
            type: 'Feature', properties: { icao: aircraft.icao, color: aircraft.color },
            geometry: { type: 'LineString', coordinates },
          });
        }
      }
      this.map.getSource('gr-adsb-trails')?.setData({
        type: 'FeatureCollection', features: trailFeatures,
      });

      const receiverFeatures = this.showReceiver ? [{
        type: 'Feature', properties: { name: 'Receiver' },
        geometry: { type: 'Point',
          coordinates: [this.receiverLongitude, this.receiverLatitude] },
      }] : [];
      this.map.getSource('gr-adsb-receiver')?.setData({
        type: 'FeatureCollection', features: receiverFeatures,
      });
      const ringFeatures = [];
      if (this.showReceiver) {
        for (const radius of [50, 100, 200]) {
          const coordinates = [];
          for (let angle = 0; angle <= 360; angle += 4)
            coordinates.push(destinationPoint(this.receiverLatitude,
              this.receiverLongitude, angle, radius));
          ringFeatures.push({ type: 'Feature', properties: { radius },
            geometry: { type: 'LineString', coordinates } });
        }
      }
      this.map.getSource('gr-adsb-rings')?.setData({
        type: 'FeatureCollection', features: ringFeatures,
      });
    }

    aircraftLabel(aircraft) {
      return aircraft.callsign || aircraft.icao;
    }

    formatAltitude(value) {
      if (!Number.isFinite(value)) return '—';
      return this.units === 'metric'
        ? `${Math.round(value * 0.3048).toLocaleString()} m`
        : `${Math.round(value).toLocaleString()} ft`;
    }

    formatSpeed(value) {
      if (!Number.isFinite(value)) return '—';
      return this.units === 'metric'
        ? `${Math.round(value * 1.852)} km/h` : `${Math.round(value)} kt`;
    }

    formatVerticalRate(value) {
      if (!Number.isFinite(value)) return '—';
      return this.units === 'metric'
        ? `${(value * 0.00508).toFixed(1)} m/s`
        : `${Math.round(value).toLocaleString()} ft/min`;
    }

    formatDistance(value) {
      if (!Number.isFinite(value)) return '—';
      return this.units === 'metric'
        ? `${value.toFixed(value < 10 ? 1 : 0)} km`
        : `${(value / 1.852).toFixed(value < 18.52 ? 1 : 0)} NM`;
    }

    sortedAircraft() {
      return [...this.aircraft.values()].sort((left, right) => {
        const leftDistance = this.receiverDistance(left);
        const rightDistance = this.receiverDistance(right);
        if (leftDistance != null && rightDistance != null)
          return leftDistance - rightDistance;
        return right.receivedAt - left.receivedAt || left.icao.localeCompare(right.icao);
      });
    }

    rebuildList() {
      const fragment = document.createDocumentFragment();
      const now = performance.now();
      for (const aircraft of this.sortedAircraft()) {
        const searchValue = `${aircraft.icao} ${aircraft.callsign || ''}`.toUpperCase();
        if (this.searchText && !searchValue.includes(this.searchText)) continue;
        const row = document.createElement('button');
        row.type = 'button';
        row.dataset.icao = aircraft.icao;
        row.className = 'gr-adsb-aircraft-row';
        row.setAttribute('aria-label', `Select ${this.aircraftLabel(aircraft)}`);
        Object.assign(row.style, {
          width: '100%', display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 8px',
          padding: '6px 8px', boxSizing: 'border-box', textAlign: 'left',
          border: '0', borderBottom: '1px solid #1d3248', cursor: 'pointer',
          color: '#dce9f7', background: aircraft.icao === this.selectedIcao
            ? '#173b4b' : '#0b1726', font: UI_MONO_FONT,
          opacity: now - aircraft.receivedAt > this.staleSeconds * 1000 ? '0.45' : '1',
        });
        const identity = document.createElement('strong');
        identity.textContent = this.aircraftLabel(aircraft);
        identity.style.color = aircraft.color;
        const altitude = document.createElement('span');
        altitude.textContent = this.formatAltitude(aircraft.altitude);
        const icao = document.createElement('span');
        icao.textContent = aircraft.callsign ? aircraft.icao : 'No callsign';
        icao.style.color = '#8199b1';
        const speed = document.createElement('span');
        speed.textContent = this.formatSpeed(aircraft.speed);
        speed.style.color = '#9db2c7';
        row.append(identity, altitude, icao, speed);
        fragment.append(row);
      }
      this.list.replaceChildren(fragment);
      if (!this.list.childElementCount) {
        const empty = document.createElement('div');
        empty.textContent = this.aircraft.size ? 'No matching aircraft' : 'Waiting for decoded aircraft…';
        Object.assign(empty.style, { padding: '12px', color: '#8199b1' });
        this.list.append(empty);
      }
    }

    updateDetails() {
      const aircraft = this.aircraft.get(this.selectedIcao);
      if (!aircraft) {
        this.details.textContent = 'Select an aircraft';
        return;
      }
      const now = performance.now();
      const distance = this.receiverDistance(aircraft);
      const bearing = this.receiverBearing(aircraft);
      const rows = [
        ['Callsign', aircraft.callsign || '—'],
        ['ICAO', aircraft.icao],
        ['Altitude', this.formatAltitude(aircraft.altitude)],
        ['Speed', this.formatSpeed(aircraft.speed)],
        ['Course', Number.isFinite(aircraft.course) ? `${aircraft.course.toFixed(0)}° true` : '—'],
        ['Vertical', this.formatVerticalRate(aircraft.vertical_rate)],
        ['Position', Number.isFinite(aircraft.latitude) && Number.isFinite(aircraft.longitude)
          ? `${aircraft.latitude.toFixed(5)}, ${aircraft.longitude.toFixed(5)}` : '—'],
        ...(this.showReceiver ? [
          ['Range', this.formatDistance(distance)],
          ['Bearing', Number.isFinite(bearing) ? `${bearing.toFixed(0)}°` : '—'],
        ] : []),
        ['SNR', Number.isFinite(aircraft.snr) ? `${aircraft.snr.toFixed(1)} dB` : '—'],
        ['DF / messages', `${Number.isFinite(aircraft.df) ? aircraft.df : '—'} / ${Number.isFinite(aircraft.num_msgs) ? aircraft.num_msgs : '—'}`],
        ['Age', formatAge(now - aircraft.receivedAt)],
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
      const positioned = this.positionedAircraft().length;
      const stale = [...this.aircraft.values()].filter(aircraft =>
        now - aircraft.receivedAt > this.staleSeconds * 1000).length;
      const source = this.basemap === 'none' || (this.map && !this.remoteStyleLoaded)
        ? 'offline map' : `${this.basemap} map`;
      this.status.textContent = `${positioned} positioned / ${this.aircraft.size} tracked` +
        `${stale ? ` · ${stale} stale` : ''} · ${source}`;
    }

    updateButtonStates() {
      const toggle = (button, active, enabled = true) => {
        button.disabled = !enabled;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.style.background = active ? '#174454' : '#12243a';
        button.style.borderColor = active ? '#45c9d8' : '#38516c';
        button.style.opacity = enabled ? '1' : '0.5';
      };
      toggle(this.followButton, this.followSelected, !!this.selectedIcao);
      toggle(this.labelsButton, this.showLabels);
      toggle(this.trailsButton, this.showTrails);
    }

    select(icao) {
      if (!this.aircraft.has(icao)) return;
      this.selectedIcao = icao;
      this.rebuildList();
      this.updateDetails();
      this.updateButtonStates();
      const aircraft = this.aircraft.get(icao);
      if (this.map && Number.isFinite(aircraft.latitude) && Number.isFinite(aircraft.longitude))
        this.map.easeTo({ center: [aircraft.longitude, aircraft.latitude],
          zoom: Math.max(this.map.getZoom(), 8), duration: 450 });
      this.dirty = true;
    }

    selectAtPoint(point) {
      if (!this.map || !point) return;
      let nearest = null;
      for (const aircraft of this.positionedAircraft()) {
        const projected = this.map.project([aircraft.longitude, aircraft.latitude]);
        const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
        if (distance <= 18 && (!nearest || distance < nearest.distance))
          nearest = { aircraft, distance };
      }
      if (nearest) this.select(nearest.aircraft.icao);
    }

    followAircraft() {
      if (!this.followSelected || !this.map) return;
      const aircraft = this.aircraft.get(this.selectedIcao);
      if (aircraft && Number.isFinite(aircraft.latitude) && Number.isFinite(aircraft.longitude))
        this.map.easeTo({ center: [aircraft.longitude, aircraft.latitude], duration: 250 });
    }

    fitAll() {
      if (!this.map || !this.mapModule) return;
      const positioned = this.positionedAircraft();
      if (!positioned.length) return;
      this.followSelected = false;
      this.updateButtonStates();
      if (positioned.length === 1) {
        this.map.easeTo({ center: [positioned[0].longitude, positioned[0].latitude],
          zoom: Math.max(this.map.getZoom(), 8), duration: 450 });
        return;
      }
      const bounds = new this.mapModule.LngLatBounds();
      for (const aircraft of positioned) bounds.extend([aircraft.longitude, aircraft.latitude]);
      this.map.fitBounds(bounds, { padding: 50, maxZoom: 10, duration: 500 });
    }

    goHome() {
      if (!this.map) return;
      this.followSelected = false;
      this.updateButtonStates();
      if (this.showReceiver)
        this.map.easeTo({ center: [this.receiverLongitude, this.receiverLatitude], zoom: 7, duration: 450 });
      else this.fitAll();
    }

    drawAircraft() {
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
      for (const aircraft of this.positionedAircraft()) {
        const point = this.map.project([aircraft.longitude, aircraft.latitude]);
        if (point.x < -30 || point.y < -30 || point.x > width + 30 || point.y > height + 30)
          continue;
        const stale = now - aircraft.receivedAt > this.staleSeconds * 1000;
        const selected = aircraft.icao === this.selectedIcao;
        context.save();
        context.globalAlpha = stale ? 0.38 : 1;
        context.translate(point.x, point.y);
        context.rotate(radians(Number.isFinite(aircraft.course) ? aircraft.course : 0));
        context.fillStyle = aircraft.color;
        context.strokeStyle = selected ? '#ffffff' : '#07121f';
        context.lineWidth = selected ? 2.5 : 1.5;
        context.beginPath();
        context.moveTo(0, -13);
        context.lineTo(8, 10);
        context.lineTo(0, 6);
        context.lineTo(-8, 10);
        context.closePath();
        context.fill();
        context.stroke();
        if (selected) {
          context.beginPath();
          context.arc(0, 0, 17, 0, Math.PI * 2);
          context.strokeStyle = '#ffffff';
          context.lineWidth = 1.5;
          context.stroke();
        }
        context.restore();

        if (this.showLabels) {
          const label = `${this.aircraftLabel(aircraft)}  ${this.formatAltitude(aircraft.altitude)}`;
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
        this.drawAircraft();
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
      const limit = clamp(Math.floor(numeric(maxPoints) ?? 32), 1, MAX_AIRCRAFT);
      const values = this.sortedAircraft();
      const aircraft = values.slice(0, limit).map(value => ({
        icao: value.icao,
        callsign: value.callsign || null,
        latitude: numeric(value.latitude),
        longitude: numeric(value.longitude),
        altitude_ft: numeric(value.altitude),
        speed_kt: numeric(value.speed),
        course_true: numeric(value.course),
        vertical_rate_ft_min: numeric(value.vertical_rate),
        snr_db: numeric(value.snr),
        df: numeric(value.df),
        messages: numeric(value.num_msgs),
        age_seconds: Math.max(0, (now - value.receivedAt) / 1000),
        stale: now - value.receivedAt > this.staleSeconds * 1000,
        selected: value.icao === this.selectedIcao,
        distance_km: this.receiverDistance(value),
        bearing_from_receiver: this.receiverBearing(value),
      }));
      const center = this.map?.getCenter();
      return {
        name: this.blockName,
        id: 'wasm_adsb_map_sink',
        kind: 'map',
        title: this.title,
        units: this.units,
        basemap: this.basemap,
        aircraft_total: values.length,
        positioned_aircraft: this.positionedAircraft().length,
        aircraft,
        selected_icao: this.selectedIcao || null,
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

  class AdsbMapManager {
    constructor() { this.instances = new Map(); this.nextId = 1; }
    create(encodedOptions) {
      try {
        const options = typeof encodedOptions === 'string'
          ? JSON.parse(encodedOptions) : encodedOptions || {};
        const id = this.nextId++;
        this.instances.set(id, new AdsbMapRenderer(id, options));
        return id;
      } catch (error) {
        console.error(`ADS-B Map: ${error?.message || error}`);
        return 0;
      }
    }
    update(id, encodedBatch) { this.instances.get(id)?.update(encodedBatch); }
    destroy(id) { this.instances.get(id)?.destroy(); this.instances.delete(id); }
    widgets() {
      return [...this.instances.values()].map(instance => ({
        name: instance.blockName, id: 'wasm_adsb_map_sink',
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

  globalThis.__grAdsbMapInternals = {
    normalizeIcao, trueCourse, altitudeColor, haversineKm, bearingDegrees,
    destinationPoint, formatAge, localStyle, graticuleGeoJson, AdsbMapRenderer,
  };
  const manager = new AdsbMapManager();
  globalThis.__grAdsbMap = manager;
  (globalThis.__grGuiLayoutListeners ||= []).push(report => manager.applyLayoutReport(report));
  globalThis.__grGuiObservation?.register('adsb-map', {
    widgets: () => manager.widgets(),
    readPlotData: (only, maxPoints) => manager.readPlotData(only, maxPoints),
    captureLayers: only => manager.captureLayers(only),
  }, 10);
})();
