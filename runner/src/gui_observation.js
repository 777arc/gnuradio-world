// Renderer-neutral observation of the GUI widgets in a running flowgraph.
//
// Providers contribute any combination of semantic plot data, live widget
// geometry, drawable canvas layers, and notes explaining something that cannot
// be captured. Qt/Qwt is one provider; browser-native instruments register
// beside it. The editor owns cropping and image encoding, so this file never
// turns a canvas into a large string.
(() => {
  'use strict';

  const finiteRect = rect => {
    if (!rect) return null;
    const normalized = {
      x: Number(rect.x), y: Number(rect.y),
      width: Number(rect.width), height: Number(rect.height),
    };
    return Object.values(normalized).every(Number.isFinite) &&
      normalized.width > 0 && normalized.height > 0 ? normalized : null;
  };

  const unionRect = (left, right) => {
    if (!left) return right;
    if (!right) return left;
    const x = Math.min(left.x, right.x);
    const y = Math.min(left.y, right.y);
    return {
      x, y,
      width: Math.max(left.x + left.width, right.x + right.width) - x,
      height: Math.max(left.y + left.height, right.y + right.height) - y,
    };
  };

  const asObject = value => {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return null; }
    }
    return typeof value === 'object' ? value : null;
  };

  class GuiObservationService {
    constructor() {
      this.providers = new Map();
      this.sequence = 0;
    }

    register(key, provider, priority = 0) {
      if (!key || !provider) throw new Error('GUI observation provider needs a key and implementation');
      const generation = ++this.sequence;
      this.providers.set(String(key), {
        provider, priority: Number(priority) || 0, generation,
      });
      return () => {
        const current = this.providers.get(String(key));
        if (current?.generation === generation) this.providers.delete(String(key));
      };
    }

    entries() {
      return [...this.providers.entries()].map(([key, value]) => ({ key, ...value }));
    }

    widgets(only = '') {
      const merged = new Map();
      for (const entry of this.entries()) {
        const widgets = entry.provider.widgets?.() || [];
        for (const widget of widgets) {
          if (!widget?.name || (only && widget.name !== only)) continue;
          const rect = finiteRect(widget.rect);
          const candidate = { ...widget, ...(rect ? { rect } : {}) };
          const previous = merged.get(widget.name);
          if (!previous || entry.priority >= previous.priority)
            merged.set(widget.name, { value: candidate, priority: entry.priority });
        }
      }
      return [...merged.values()].map(entry => entry.value);
    }

    readPlotData(only = '', maxPoints = 32) {
      const merged = new Map();
      const notes = [];
      for (const entry of this.entries()) {
        if (typeof entry.provider.readPlotData !== 'function') continue;
        try {
          const result = asObject(entry.provider.readPlotData(only, maxPoints));
          for (const widget of Array.isArray(result?.widgets) ? result.widgets : []) {
            if (!widget?.name || (only && widget.name !== only)) continue;
            const previous = merged.get(widget.name);
            if (!previous || entry.priority >= previous.priority)
              merged.set(widget.name, { value: widget, priority: entry.priority });
          }
          if (Array.isArray(result?.notes)) notes.push(...result.notes.map(String));
        } catch (error) {
          notes.push(`${entry.key} GUI data could not be read: ${error?.message || error}`);
        }
      }
      const widgets = [...merged.values()].map(entry => entry.value);
      return {
        widgets,
        ...(notes.length ? { notes: [...new Set(notes)] } : {}),
        ...(only && !widgets.length
          ? { error: `no GUI widget named "${only}" is running` } : {}),
      };
    }

    capturePlan(only = '') {
      const widgets = this.widgets();
      const layers = [];
      const notes = [];
      let declaredBounds = null;
      let contentBounds = null;
      for (const entry of this.entries()) {
        try {
          const providerBounds = finiteRect(entry.provider.bounds?.());
          declaredBounds = unionRect(declaredBounds, providerBounds);
          for (const layer of entry.provider.captureLayers?.(only) || []) {
            const rect = finiteRect(layer?.rect);
            if (!layer?.source || !rect || (only && layer.widget && layer.widget !== only))
              continue;
            layers.push({ ...layer, rect, provider: entry.key,
              z: Number(layer.z) || 0 });
            contentBounds = unionRect(contentBounds, rect);
          }
          for (const note of entry.provider.captureNotes?.(only) || [])
            notes.push(String(note));
        } catch (error) {
          notes.push(`${entry.key} GUI could not be captured: ${error?.message || error}`);
        }
      }
      for (const widget of widgets)
        contentBounds = unionRect(contentBounds, finiteRect(widget.rect));
      layers.sort((left, right) => left.z - right.z);
      const bounds = declaredBounds || contentBounds;
      return { widgets, layers, ...(bounds ? { bounds } : {}),
        notes: [...new Set(notes)] };
    }
  }

  const service = new GuiObservationService();
  globalThis.__grGuiObservation = service;

  // Qt remains the broad fallback: Qwt supplies semantic data for its plots,
  // its canvas supplies one background layer, and the layout report names its
  // widgets. A browser-native provider with the same instance name has higher
  // priority and replaces the empty QWidget placeholder's semantic entry.
  service.register('qt', {
    widgets: () => globalThis.__grGuiLayout?.widgets || [],
    bounds: () => globalThis.__grGuiLayout?.rect || null,
    readPlotData: (only, maxPoints) =>
      globalThis.__grReadQtPlotData?.(only, maxPoints) || null,
    captureLayers: () => {
      const container = document.querySelector('#qt-shadow-container');
      const canvas = container?.shadowRoot?.querySelector('canvas.qt-window-canvas');
      if (!canvas?.width || !canvas?.height) return [];
      const rect = canvas.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        ? [{ source: canvas, rect, z: 0 }] : [];
    },
  }, 0);

  // Kept public only for small Node tests; production consumers use the single
  // service above.
  globalThis.__grGuiObservationInternals = { GuiObservationService, finiteRect, unionRect };
})();
