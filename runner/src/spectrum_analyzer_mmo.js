// Optional MMO presentation for the browser-native Spectrum Analyzer. This
// module deliberately knows nothing about WASM, FFT frames, threshold learning,
// zooming, GUI placement, or plot observation. spectrum_analyzer.js hands it
// already-measured signals with stable ids and the geometry needed to draw.
(() => {
  'use strict';

  const LEVEL_INTERVAL_MS = 5000;
  const DAMAGE_THRESHOLD_DB = 3;
  const CRITICAL_THRESHOLD_DB = 10;
  const BOSS_SWITCH_MARGIN_DB = 1.5;
  const SPAWN_DURATION_MS = 700;
  const DISSOLVE_DURATION_MS = 800;
  const BLEED_DURATION_MS = 1200;
  const DAMAGE_TEXT_DURATION_MS = 1050;
  const LEVEL_UP_DURATION_MS = 1200;
  const MMO_BOLD_FONT = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';

  const finite = (value, fallback = 0) => Number.isFinite(Number(value))
    ? Number(value) : fallback;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  function healthFraction(power, minimum, maximum) {
    const low = finite(minimum, -100);
    const high = finite(maximum, 0);
    if (!(high > low)) return 1;
    return clamp((finite(power, low) - low) / (high - low), 0, 1);
  }

  function healthColor(fraction) {
    if (fraction > 0.6) return '#43e36f';
    if (fraction > 0.3) return '#f5bd3d';
    return '#ef4f56';
  }

  function classifySignal(signal, metrics = {}) {
    const span = Math.max(1, Math.abs(finite(metrics.spanHz, 1)));
    const rbw = Math.max(1e-9, finite(metrics.rbwHz, span / 512));
    const width = Math.max(0, finite(signal?.width));
    const fraction = healthFraction(signal?.totalPower,
      metrics.minimumLevel, metrics.maximumLevel);
    let name = width >= span * 0.08 ? 'Wideband Brute' :
      width <= rbw * 4 ? 'Tone Imp' : 'Signal Bandit';
    if (fraction >= 0.75) name = `Elite ${name}`;
    return name;
  }

  function placeBar(rect, centerX, anchorY, width, height, occupied) {
    const left = clamp(centerX - width / 2, rect.left + 3, rect.right - width - 3);
    const collides = candidate => occupied.some(box =>
      candidate.left < box.right + 4 && candidate.right + 4 > box.left &&
      candidate.top < box.bottom + 4 && candidate.bottom + 4 > box.top);
    const minimumTop = rect.top + 22;
    const maximumTop = rect.bottom - height - 3;
    const candidates = [];
    for (let lane = 0; lane < 7; lane++) {
      candidates.push(anchorY - height - 10 - lane * (height + 5));
      candidates.push(anchorY + 10 + lane * (height + 5));
    }
    for (let top = minimumTop; top <= maximumTop; top += height + 5)
      candidates.push(top);
    let candidate = null;
    for (const top of candidates) {
      if (top < minimumTop || top > maximumTop) continue;
      const proposed = { left, right: left + width, top, bottom: top + height };
      if (!collides(proposed)) { candidate = proposed; break; }
    }
    candidate ||= { left, right: left + width, top: maximumTop,
      bottom: maximumTop + height };
    occupied.push(candidate);
    return candidate;
  }

  function overlapsNow(until, now) {
    return Number.isFinite(until) && until > now;
  }

  class MmoSpectrumPresentation {
    constructor(options = {}) {
      this.levelUnit = String(options.levelUnit || 'dBFS');
      this.invalidate = typeof options.invalidate === 'function'
        ? options.invalidate : () => {};
      this.tracks = new Map();
      this.retired = [];
      this.bossId = null;
      this.held = false;
      this.holdStartedAt = null;
      this.soundEnabled = false;
      this.audioContext = null;
      this.lastCueTime = -Infinity;
      this.soundButton = null;
      if (options.toolbar && typeof options.buttonFactory === 'function')
        this.attachToolbar(options.toolbar, options.buttonFactory);
    }

    attachToolbar(toolbar, buttonFactory) {
      this.soundButton = buttonFactory('Sound Off', 'mmo-sound',
        'Enable MMO damage, critical, level-up, and signal-loss sounds');
      this.soundButton.setAttribute('aria-label', 'MMO sound effects');
      this.soundButton.setAttribute('aria-pressed', 'false');
      this.soundButton.addEventListener('click', event => {
        event.stopPropagation();
        this.toggleSound().catch(error =>
          console.warn(`Spectrum Analyzer MMO sound: ${error.message || error}`));
      });
      toolbar.append(this.soundButton);
    }

    async toggleSound() {
      this.soundEnabled = !this.soundEnabled;
      if (this.soundEnabled) {
        const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContextClass) {
          this.soundEnabled = false;
        } else {
          this.audioContext ||= new AudioContextClass();
          await this.audioContext.resume?.();
        }
      }
      if (this.soundButton) {
        this.soundButton.textContent = this.soundEnabled ? 'Sound On' : 'Sound Off';
        this.soundButton.setAttribute('aria-pressed', this.soundEnabled ? 'true' : 'false');
      }
      this.invalidate();
    }

    playCue(kind) {
      const audio = this.audioContext;
      if (!this.soundEnabled || !audio || audio.state !== 'running') return;
      const settings = {
        damage: [150, 0.12, 'sawtooth'], critical: [75, 0.24, 'square'],
        level: [660, 0.18, 'sine'], lost: [110, 0.20, 'triangle'],
      }[kind];
      if (!settings) return;
      const [frequency, duration, type] = settings;
      const start = audio.currentTime;
      // A noisy threshold can lose several tiny regions in one FFT frame. One
      // cue represents that event burst without stacking enough oscillators to
      // clip or turn a momentary loss into an unpleasant wall of sound.
      if (start - this.lastCueTime < 0.08) return;
      this.lastCueTime = start;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (kind === 'level')
        oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.5, start + duration);
      else if (kind === 'critical')
        oscillator.frequency.exponentialRampToValueAtTime(frequency / 2, start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.055, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
    }

    setLevelUnit(unit) { this.levelUnit = String(unit || this.levelUnit); }

    setHeld(held, now) {
      now = finite(now);
      if (!!held === this.held) return;
      this.held = !!held;
      if (this.held) {
        this.holdStartedAt = now;
        return;
      }
      const paused = Math.max(0, now - finite(this.holdStartedAt, now));
      const shift = state => {
        for (const key of ['firstSeenAt', 'lastSeenAt', 'spawnUntil', 'bleedStartedAt',
          'bleedUntil', 'damageStartedAt', 'damageUntil', 'levelUpUntil']) {
          if (Number.isFinite(state[key])) state[key] += paused;
        }
        for (const sample of state.history || []) sample.time += paused;
      };
      for (const state of this.tracks.values()) shift(state);
      for (const retired of this.retired) {
        retired.startedAt += paused;
        retired.until += paused;
      }
      this.holdStartedAt = null;
      this.invalidate();
    }

    updateStatuses(state, signal, now, metrics) {
      state.history.push({ time: now, power: signal.totalPower, center: signal.center });
      state.history = state.history.filter(sample => now - sample.time <= 2500);
      const oldest = state.history[0] || state.history[state.history.length - 1];
      const rbw = Math.max(1e-9, finite(metrics.rbwHz, 1));
      state.statuses = {
        fading: finite(signal.totalPower) < finite(oldest?.power) - 1.5,
        moving: Math.abs(finite(signal.center) - finite(oldest?.center)) >
          Math.max(3 * rbw, Math.max(0, finite(signal.width)) * 0.25),
        wide: Math.max(0, finite(signal.width)) >=
          Math.max(1, Math.abs(finite(metrics.spanHz, 1))) * 0.08,
        veteran: state.level >= 6,
      };
    }

    updateBoss(signals) {
      const ranked = [...signals].sort((a, b) =>
        finite(b.totalPower) - finite(a.totalPower) || finite(b.width) - finite(a.width));
      const strongest = ranked[0];
      const current = signals.find(signal => signal.id === this.bossId);
      let next = current || strongest || null;
      if (current && strongest && strongest.id !== current.id &&
          finite(strongest.totalPower) > finite(current.totalPower) + BOSS_SWITCH_MARGIN_DB)
        next = strongest;
      const nextId = next?.id ?? null;
      this.bossId = nextId;
    }

    update(signals, now, metrics = {}) {
      if (this.held) return;
      now = finite(now);
      signals = Array.isArray(signals) ? signals : [];
      const present = new Set();
      for (const signal of signals) {
        present.add(signal.id);
        let state = this.tracks.get(signal.id);
        if (!state) {
          state = {
            id: signal.id,
            title: classifySignal(signal, metrics),
            firstSeenAt: now,
            lastSeenAt: now,
            level: 1,
            maxPower: finite(signal.totalPower),
            spawnUntil: now + SPAWN_DURATION_MS,
            history: [],
            statuses: {},
          };
          this.tracks.set(signal.id, state);
        } else {
          const nextLevel = 1 + Math.floor(Math.max(0, now - state.firstSeenAt) /
            LEVEL_INTERVAL_MS);
          if (nextLevel > state.level) {
            state.level = nextLevel;
            state.levelUpUntil = now + LEVEL_UP_DURATION_MS;
            this.playCue('level');
          }
          const power = finite(signal.totalPower);
          const damage = finite(state.maxPower, power) - power;
          if (damage > DAMAGE_THRESHOLD_DB) {
            const critical = damage > CRITICAL_THRESHOLD_DB;
            state.damageAmount = damage;
            state.damageCritical = critical;
            state.damageStartedAt = now;
            state.damageUntil = now + DAMAGE_TEXT_DURATION_MS;
            state.bleedStartedAt = now;
            state.bleedUntil = now + BLEED_DURATION_MS;
            // A damage event establishes a fresh maximum, so the same loss is
            // not reported again on every subsequent FFT frame.
            state.maxPower = power;
            this.playCue(critical ? 'critical' : 'damage');
          } else {
            state.maxPower = Math.max(finite(state.maxPower, power), power);
          }
        }
        state.lastSeenAt = now;
        state.signal = { ...signal };
        this.updateStatuses(state, signal, now, metrics);
      }

      for (const [id, state] of [...this.tracks]) {
        if (present.has(id)) continue;
        this.tracks.delete(id);
        this.retired.push({
          id, title: state.title, level: state.level, color: state.signal?.color,
          signal: state.signal, startedAt: now, until: now + DISSOLVE_DURATION_MS,
        });
        this.playCue('lost');
      }
      this.retired = this.retired.filter(retired => retired.until > now);
      this.updateBoss(signals);
      this.invalidate();
    }

    reset() {
      this.tracks.clear();
      this.retired = [];
      this.bossId = null;
      this.invalidate();
    }

    needsRedraw(now) {
      now = finite(now);
      if (this.retired.some(item => item.until > now)) return true;
      for (const state of this.tracks.values()) {
        if (overlapsNow(state.spawnUntil, now) || overlapsNow(state.bleedUntil, now) ||
            overlapsNow(state.damageUntil, now) || overlapsNow(state.levelUpUntil, now))
          return true;
      }
      return false;
    }

    drawSpawn(context, state, x, y, now) {
      if (!overlapsNow(state.spawnUntil, now)) return;
      const progress = clamp(1 - (state.spawnUntil - now) / SPAWN_DURATION_MS, 0, 1);
      context.strokeStyle = `rgba(105, 241, 255, ${1 - progress})`;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(x, y, 7 + progress * 25, 0, Math.PI * 2);
      context.stroke();
    }

    drawDamage(context, state, signal, x, y, now) {
      if (overlapsNow(state.bleedUntil, now)) {
        const progress = clamp((now - state.bleedStartedAt) / BLEED_DURATION_MS, 0, 1);
        context.fillStyle = `rgba(220, 25, 38, ${0.8 * (1 - progress)})`;
        for (let index = 0; index < 9; index++) {
          const phase = state.id * 1.73 + index * 2.41;
          const spread = Math.max(18, Math.min(80, finite(signal.width) * 0.001));
          const px = x + Math.sin(phase) * spread * (0.3 + progress);
          const py = y + 6 + progress * (22 + (index % 4) * 8);
          const radius = Math.max(1, 3.5 - progress * 2 + (index % 2));
          context.beginPath(); context.arc(px, py, radius, 0, Math.PI * 2); context.fill();
        }
        context.strokeStyle = `rgba(255, 45, 55, ${0.75 * (1 - progress)})`;
        context.lineWidth = state.damageCritical ? 4 : 2;
        context.beginPath(); context.arc(x, y, 10 + progress * 28, 0, Math.PI * 2);
        context.stroke();
      }
      if (overlapsNow(state.damageUntil, now)) {
        const progress = clamp((now - state.damageStartedAt) /
          DAMAGE_TEXT_DURATION_MS, 0, 1);
        context.font = state.damageCritical ? '700 18px system-ui, sans-serif' : MMO_BOLD_FONT;
        context.textAlign = 'center'; context.textBaseline = 'bottom';
        context.fillStyle = `rgba(255, ${state.damageCritical ? 55 : 105}, 72, ${1 - progress})`;
        const label = state.damageCritical
          ? `CRITICAL -${state.damageAmount.toFixed(1)} dB`
          : `-${state.damageAmount.toFixed(1)} dB`;
        context.fillText(label, x, y - 24 - progress * 25);
      }
    }

    drawLevelUp(context, state, x, y, now) {
      if (!overlapsNow(state.levelUpUntil, now)) return;
      const progress = clamp(1 - (state.levelUpUntil - now) / LEVEL_UP_DURATION_MS, 0, 1);
      context.font = '700 17px system-ui, sans-serif';
      context.textAlign = 'center'; context.textBaseline = 'bottom';
      context.fillStyle = `rgba(255, 220, 70, ${1 - progress})`;
      context.fillText('LEVEL UP!', x, y - 28 - progress * 18);
    }

    drawStatuses(context, state, x, y) {
      const entries = [
        [state.statuses.fading, '↓', '#ef6b73'],
        [state.statuses.moving, '↔', '#79c8ff'],
        [state.statuses.wide, 'W', '#c28cff'],
        [state.statuses.veteran, '★', '#ffd84d'],
      ].filter(([active]) => active);
      if (!entries.length) return;
      context.font = MMO_BOLD_FONT;
      context.textAlign = 'left'; context.textBaseline = 'middle';
      entries.forEach(([, label, color], index) => {
        context.fillStyle = 'rgba(6, 10, 18, .9)';
        context.beginPath(); context.arc(x + index * 18, y, 7, 0, Math.PI * 2); context.fill();
        context.fillStyle = color;
        context.fillText(label, x - 4 + index * 18, y + 0.5);
      });
    }

    drawBar(context, state, signal, box, metrics, isBoss) {
      const fraction = healthFraction(signal.totalPower,
        metrics.minimumLevel, metrics.maximumLevel);
      const barTop = box.top + 15;
      const barHeight = isBoss ? 14 : 11;
      context.fillStyle = 'rgba(5, 9, 18, .84)';
      context.fillRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
      context.strokeStyle = isBoss ? '#f4cf4c' : signal.color;
      context.lineWidth = isBoss ? 2 : 1;
      context.strokeRect(box.left + 0.5, box.top + 0.5,
        box.right - box.left - 1, box.bottom - box.top - 1);
      context.font = MMO_BOLD_FONT;
      context.textAlign = 'center'; context.textBaseline = 'top';
      context.fillStyle = isBoss ? '#ffe788' : signal.color;
      context.fillText(`${isBoss ? 'BOSS · ' : ''}S${signal.id} · Lv ${state.level} · ${state.title}`,
        (box.left + box.right) / 2, box.top + 1);
      context.fillStyle = '#2b1720';
      context.fillRect(box.left + 4, barTop, box.right - box.left - 8, barHeight);
      context.fillStyle = healthColor(fraction);
      context.fillRect(box.left + 4, barTop,
        (box.right - box.left - 8) * fraction, barHeight);
      context.strokeStyle = 'rgba(255,255,255,.42)'; context.lineWidth = 1;
      context.strokeRect(box.left + 4.5, barTop + 0.5,
        box.right - box.left - 9, barHeight - 1);
      context.font = MMO_BOLD_FONT;
      context.fillStyle = '#fff'; context.textBaseline = 'middle';
      context.fillText(`${finite(signal.totalPower).toFixed(1)} ${this.levelUnit}`,
        (box.left + box.right) / 2, barTop + barHeight / 2);
      this.drawStatuses(context, state, box.left + 10, box.bottom - 7);
    }

    drawTarget(context, rect, signal, env, isBoss) {
      const low = clamp(env.xForFrequency(signal.low), rect.left, rect.right);
      const high = clamp(env.xForFrequency(signal.high), rect.left, rect.right);
      const center = env.xForFrequency(signal.center);
      const top = rect.top + 38;
      const bottom = rect.bottom - 5;
      context.strokeStyle = isBoss ? 'rgba(255, 211, 68, .8)' : 'rgba(122, 215, 255, .7)';
      context.lineWidth = 2;
      const arm = 9;
      for (const [x, direction] of [[low, 1], [high, -1]]) {
        context.beginPath(); context.moveTo(x, top + arm); context.lineTo(x, top);
        context.lineTo(x + direction * arm, top); context.stroke();
        context.beginPath(); context.moveTo(x, bottom - arm); context.lineTo(x, bottom);
        context.lineTo(x + direction * arm, bottom); context.stroke();
      }
      context.beginPath(); context.arc(center, top + 3, 3, 0, Math.PI * 2); context.stroke();
    }

    drawRetired(context, retired, env, now) {
      const signal = retired.signal;
      if (!signal || retired.until <= now) return;
      const progress = clamp((now - retired.startedAt) / DISSOLVE_DURATION_MS, 0, 1);
      const x = env.xForFrequency(signal.center);
      const y = env.yForLevel(signal.peakLevel);
      context.font = MMO_BOLD_FONT;
      context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillStyle = `rgba(165, 182, 205, ${1 - progress})`;
      context.fillText(`S${retired.id} LOST`, x, y - progress * 20);
      for (let index = 0; index < 8; index++) {
        const phase = retired.id * 0.9 + index * 1.7;
        context.fillRect(x + Math.sin(phase) * progress * 30,
          y + Math.cos(phase) * progress * 24, 2, 2);
      }
    }

    draw(context, signals, now, env) {
      if (!context || !env?.rect) return;
      now = finite(now);
      const metrics = {
        minimumLevel: env.minimumLevel,
        maximumLevel: env.maximumLevel,
      };
      context.save();
      for (const retired of this.retired) this.drawRetired(context, retired, env, now);

      const occupied = [];
      const visible = (signals || []).filter(signal =>
        signal.center >= env.firstFrequency && signal.center <= env.lastFrequency);
      for (const signal of visible) {
        const state = this.tracks.get(signal.id);
        if (!state) continue;
        const isBoss = signal.id === this.bossId;
        const centerX = env.xForFrequency(signal.center);
        const peakX = env.xForFrequency(signal.peakFrequency);
        const peakY = env.yForLevel(signal.peakLevel);
        context.fillStyle = signal.color;
        context.beginPath(); context.arc(peakX, peakY, 3, 0, Math.PI * 2); context.fill();
        context.font = MMO_BOLD_FONT;
        const label = `${isBoss ? 'BOSS · ' : ''}S${signal.id} · Lv ${state.level} · ${state.title}`;
        const labelWidth = context.measureText(label).width + 14;
        const width = clamp(labelWidth, isBoss ? 210 : 145,
          Math.max(isBoss ? 210 : 145, env.rect.right - env.rect.left - 8));
        const height = 45;
        const box = placeBar(env.rect, centerX, peakY, width, height, occupied);
        this.drawBar(context, state, signal, box, metrics, isBoss);
        if (isBoss) this.drawTarget(context, env.rect, signal, env, true);
        this.drawSpawn(context, state, peakX, peakY, now);
        this.drawDamage(context, state, signal, peakX, peakY, now);
        this.drawLevelUp(context, state, peakX, peakY, now);
      }
      context.restore();
    }

    destroy() {
      this.soundButton?.remove();
      this.soundButton = null;
      const closing = this.audioContext?.close?.();
      closing?.catch?.(() => {});
      this.audioContext = null;
      this.reset();
    }
  }

  globalThis.__grCreateSpectrumAnalyzerMmo = options =>
    new MmoSpectrumPresentation(options);
  globalThis.__grSpectrumAnalyzerMmoInternals = {
    MmoSpectrumPresentation, healthFraction, healthColor, classifySignal, placeBar,
    LEVEL_INTERVAL_MS, DAMAGE_THRESHOLD_DB, CRITICAL_THRESHOLD_DB,
    BOSS_SWITCH_MARGIN_DB,
  };
})();
