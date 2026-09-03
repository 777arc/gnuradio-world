// Wiring for the challenge flowgraphs: the part of challenge.ts that needs the
// browser. It keeps one challenge's checklist current — static criteria on every
// graph mutation, live ones polled off the running flowgraph's GUI sinks — draws
// the progress chip in the workspace tab bar, records a pass, and announces it.
//
// The evaluation itself is in challenge.ts and stays DOM-free; this file holds
// no rules of its own.

import {
  allMet, challengeStatus, evaluateLive, evaluateStatic,
  latchLive, mergeStates, metCount, parseChallenge, passedIds, recordPass,
  resetProgress,
  type ChallengeSpec, type ChallengeStatus, type CriterionState, type PlotData,
} from './challenge';
import type { Conn, Inst } from './graph-model';
import type { Scope } from './expr';

/** How often the running flowgraph's sinks are asked what they are showing. */
const LIVE_POLL_MS = 500;
/** How long the "challenge passed" banner stays up before it fades itself. */
const BANNER_MS = 14000;

export interface ChallengeSessionDeps {
  blocks(): readonly Inst[];
  connections(): readonly Conn[];
  scope(): Scope;
  /** The flowgraph title, used when the Challenge block names none itself. */
  flowgraphTitle(): string;
  /** readPlotData() over the running runner frame; rejects while it starts up. */
  readPlotData(): Promise<PlotData>;
  log(message: string): void;
  /** Repaint anything that shows progress — the Example Flowgraphs list. */
  onProgressChanged(): void;
  /**
   * Redraw the canvas after a live result arrives. The poll loop runs off a
   * timer rather than off a graph mutation, so nothing else would repaint the
   * Challenge block's checklist. Never called from refresh(), which render()
   * itself calls — that would recurse.
   */
  requestRender(): void;
  /** Where the chip goes (the workspace tab bar) and where the banner goes. */
  chipContainer(): HTMLElement;
  bannerContainer(): HTMLElement;
  /** ?challenges=unlocked: every challenge open, for development and harnesses. */
  unlockAll: boolean;
}

const ICONS: Record<CriterionState, string> = { met: '✓', unmet: '○', pending: '◌' };

/** The `✓ Set the tone to 200 Hz` line a checklist row shows. */
export const criterionLine = (state: CriterionState, goal: string): string =>
  `${ICONS[state]} ${goal}`;

export class ChallengeSession {
  private readonly deps: ChallengeSessionDeps;
  private spec: ChallengeSpec | null = null;
  private states: CriterionState[] = [];
  /** This run's live results, latched until the next run starts. */
  private live: CriterionState[] = [];
  private plotData: PlotData | null = null;
  private runStartedAt = 0;
  private running = false;
  private pollTimer = 0;
  /** Criteria already announced in the console, so each is logged once. */
  private announced = new Set<number>();
  /**
   * Whether the checklist was complete at the previous refresh. A pass is
   * recorded on the *transition* into complete, not while it stays complete:
   * level-triggering would re-record on every refresh, and would make Help >
   * Reset Challenge Progress silently undo itself whenever the solved
   * flowgraph is still on the canvas.
   */
  private wasComplete = false;
  private chip: HTMLElement | null = null;
  private banner: HTMLElement | null = null;
  private bannerTimer = 0;

  constructor(deps: ChallengeSessionDeps) { this.deps = deps; }

  /** The challenge on the canvas, or null. Reparsed on every refresh(). */
  current(): ChallengeSpec | null { return this.spec; }

  /** The checklist as the block face and the chip should show it. */
  criterionStates(): CriterionState[] { return this.states; }

  /** Which challenge ids this browser has passed. */
  passed(): Set<string> { return passedIds(); }

  /**
   * Where a challenge stands for this browser, honouring ?challenges=unlocked —
   * the one place the development override lives, so the palette, the canvas
   * and the chip cannot disagree about what is open.
   */
  statusOf(spec: Pick<ChallengeSpec, 'id' | 'requires'>): ChallengeStatus {
    const passed = this.passed();
    if (this.deps.unlockAll && challengeStatus(spec, passed) === 'locked')
      return 'unlocked';
    return challengeStatus(spec, passed);
  }

  /**
   * Recompute the checklist. Called from render(), i.e. on every graph
   * mutation, which is the same hook validation already runs on.
   */
  refresh(): void {
    const previous = this.spec?.id ?? null;
    this.spec = parseChallenge(this.deps.blocks());
    // A different challenge on the canvas is a different checklist: nothing the
    // previous run saw applies to it.
    if ((this.spec?.id ?? null) !== previous) {
      this.live = [];
      this.plotData = null;
      this.announced.clear();
      this.wasComplete = false;
    }
    if (!this.spec) { this.states = []; this.syncPolling(); this.updateChip(); return; }
    const staticStates = evaluateStatic(
      this.spec, this.deps.blocks(), this.deps.connections(), this.deps.scope());
    this.states = mergeStates(staticStates, this.live);
    this.syncPolling();
    this.announceProgress();
    this.updateChip();
  }

  /**
   * The run start/stop hook. Live results never survive across runs.
   *
   * Every flowgraph runs through here, and the overwhelming majority state no
   * challenge, so nothing below may cost one of those anything: no poll timer
   * and no repaint unless there is actually a checklist to move.
   */
  setRunning(running: boolean): void {
    if (running === this.running) return;
    this.running = running;
    // A tone seen in the previous run must not pass a graph that no longer
    // produces it, so a new run starts from nothing rather than from a latch.
    this.live = [];
    this.plotData = null;
    if (running) this.runStartedAt = Date.now();
    this.syncPolling();
    if (this.spec) this.deps.requestRender();
  }

  /**
   * Start or stop the poll loop to match "a challenge is running". Idempotent,
   * and called from refresh() as well as from setRunning(), so a challenge that
   * reaches the canvas mid-run still gets polled.
   */
  private syncPolling(): void {
    const wanted = this.running && !!this.spec;
    if (wanted === !!this.pollTimer) return;
    if (!wanted) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = 0;
      return;
    }
    // Assigned before the immediate poll, whose own refresh() comes back
    // through here: the timer is what makes that call a no-op rather than a
    // second loop.
    this.pollTimer = window.setInterval(() => void this.poll(), LIVE_POLL_MS);
    void this.poll();
  }

  /** The flowgraph failed: its elapsed time no longer counts towards `ran`. */
  runFailed(): void {
    this.runStartedAt = 0;
    this.live = [];
    if (this.spec) this.deps.requestRender();
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.spec) return;
    try { this.plotData = await this.deps.readPlotData(); }
    catch {
      // Normal for the first second of a run, and normal forever for a
      // challenge whose flowgraph has no analyzer to read. `ran` still ticks.
    }
    if (!this.running) return;
    const elapsed = this.runStartedAt ? (Date.now() - this.runStartedAt) / 1000 : 0;
    const before = this.states.join(',');
    this.live = latchLive(this.live,
      evaluateLive(this.spec, this.plotData, elapsed));
    this.refresh();
    if (this.states.join(',') !== before) this.deps.requestRender();
  }

  /** Log each criterion as it is first met, and record the pass when all are. */
  private announceProgress(): void {
    const spec = this.spec;
    if (!spec) return;
    this.states.forEach((state, index) => {
      if (state !== 'met' || this.announced.has(index)) return;
      this.announced.add(index);
      this.deps.log(`challenge ✓ ${spec.criteria[index]?.goal ?? ''}`);
    });
    const complete = allMet(this.states), wasComplete = this.wasComplete;
    this.wasComplete = complete;
    if (!complete || wasComplete || !spec.id) return;
    const already = passedIds().has(spec.id);
    recordPass(spec.id);
    const name = this.challengeName();
    this.deps.log(already
      ? `challenge "${name}" passed again — all ${this.states.length} criteria met`
      : `challenge "${name}" passed — all ${this.states.length} criteria met`);
    this.deps.onProgressChanged();
    if (!already) this.showBanner(name);
  }

  private challengeName(): string {
    return this.spec?.title || this.deps.flowgraphTitle() || this.spec?.id || 'this challenge';
  }

  // ---- chrome -------------------------------------------------------------

  /**
   * `Challenge 0 · 2/3` in the workspace tab bar. The canvas is not on screen
   * during a run — the runner has a workspace tab of its own — so the checklist
   * on the block face cannot be the only place progress shows.
   */
  private updateChip(): void {
    const spec = this.spec;
    if (!spec) { this.chip?.remove(); this.chip = null; return; }
    if (!this.chip) {
      this.chip = document.createElement('div');
      this.chip.id = 'challengeChip';
      this.chip.className = 'challenge-chip';
      this.chip.setAttribute('role', 'status');
      this.deps.chipContainer().appendChild(this.chip);
    }
    const done = metCount(this.states), total = this.states.length;
    const complete = total > 0 && done === total;
    this.chip.classList.toggle('complete', complete);
    this.chip.textContent = total
      ? `${complete ? '✅' : '🎯'} ${this.challengeName()} · ${done}/${total}`
      : `🎯 ${this.challengeName()}`;
    this.chip.title = total
      ? `${done} of ${total} success criteria met for “${this.challengeName()}”`
      : `“${this.challengeName()}” states no success criteria`;
  }

  private showBanner(name: string): void {
    window.clearTimeout(this.bannerTimer);
    if (!this.banner) {
      this.banner = document.createElement('div');
      this.banner.className = 'challenge-banner';
      this.banner.setAttribute('role', 'status');
      const dismiss = document.createElement('button');
      dismiss.className = 'challenge-banner-close';
      dismiss.type = 'button';
      dismiss.textContent = '✕';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.onclick = () => this.hideBanner();
      const text = document.createElement('div');
      text.className = 'challenge-banner-text';
      this.banner.append(text, dismiss);
      this.deps.bannerContainer().appendChild(this.banner);
    }
    const text = this.banner.querySelector('.challenge-banner-text')!;
    text.textContent =
      `Challenge passed: ${name}. The next challenge is unlocked in Example Flowgraphs.`;
    this.banner.hidden = false;
    this.bannerTimer = window.setTimeout(() => this.hideBanner(), BANNER_MS);
  }

  private hideBanner(): void {
    window.clearTimeout(this.bannerTimer);
    if (this.banner) this.banner.hidden = true;
  }

  /** Help ▸ Reset Challenge Progress. */
  reset(): void {
    resetProgress();
    this.hideBanner();
    this.deps.onProgressChanged();
    // `wasComplete` is deliberately left alone: a reset performed with the
    // solved flowgraph still open must not be undone by the very next
    // refresh(), and breaking the flowgraph and solving it again re-earns the
    // pass through the same transition as the first time. Nothing on the
    // checklist depends on the progress store, so no repaint is needed either.
  }
}
