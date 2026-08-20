import type { GraphSnapshot, Inst } from '../graph-model';
import { runnableIndex, type CatalogEntry } from './catalog';
import { FlowgraphAgent, type AgentHooks } from './agent';
import {
  DEFAULT_OPENROUTER_MODEL,
  beginOpenRouterOAuth,
  exchangeOpenRouterCode,
  forgetKey,
  hasConsent,
  keyIsRemembered,
  listModels,
  storeConsent,
  storedKey,
  storedModel,
  storeKey,
  storeModel,
  takeOpenRouterOAuthReturn,
  type OpenRouterModel,
} from './openrouter';
import { runFlowgraph, type HarnessDeps, type RunAuthorization } from './harness';
import type { AiToolDeps } from './tools';

export interface AiPanelDeps {
  openDialog(title: string, build: (body: HTMLElement) => void, wide?: boolean): HTMLElement;
  log(message: string): void;
  systemPrompt: string;
  entries(): CatalogEntry[];
  toolDeps: Omit<AiToolDeps, 'runFlowgraph'>;
  harness: Omit<HarnessDeps, 'requestAuthorization'>;
  snapshot(): GraphSnapshot;
  commitHistory(): void;
  restoreSnapshot(snapshot: GraphSnapshot, record: boolean): void;
}

export interface AiPanel {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  isOAuthReturn(): boolean;
  oauthRestore(): Promise<GraphSnapshot | null>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''):
    HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function byName(snapshot: GraphSnapshot): Map<string, Inst> {
  return new Map(snapshot.insts.map(block => [block.name, block]));
}

function connectionText(snapshot: GraphSnapshot): Set<string> {
  const names = new Map(snapshot.insts.map(block => [block.uid, block.name]));
  return new Set(snapshot.conns.map(connection =>
    `${names.get(connection.from)}:${connection.fp} → ${names.get(connection.to)}:${connection.tp}`));
}

export function graphDiff(before: GraphSnapshot, after: GraphSnapshot): string[] {
  const left = byName(before), right = byName(after);
  const lines: string[] = [];
  for (const [name, block] of right)
    if (!left.has(name)) lines.push(`Added ${name} (${block.id})`);
  for (const [name, block] of left)
    if (!right.has(name)) lines.push(`Removed ${name} (${block.id})`);
  for (const [name, next] of right) {
    const previous = left.get(name);
    if (!previous) continue;
    const keys = new Set([...Object.keys(previous.params), ...Object.keys(next.params)]);
    for (const key of keys) {
      if (same(previous.params[key], next.params[key])) continue;
      lines.push(`${name}.${key}: ${JSON.stringify(previous.params[key])} → ${JSON.stringify(next.params[key])}`);
    }
    const oldState = previous.bypassed ? 'bypassed' : previous.enabled ? 'enabled' : 'disabled';
    const newState = next.bypassed ? 'bypassed' : next.enabled ? 'enabled' : 'disabled';
    if (oldState !== newState) lines.push(`${name}: ${oldState} → ${newState}`);
  }
  const oldConnections = connectionText(before), newConnections = connectionText(after);
  for (const value of newConnections) if (!oldConnections.has(value)) lines.push(`Connected ${value}`);
  for (const value of oldConnections) if (!newConnections.has(value)) lines.push(`Disconnected ${value}`);
  return lines;
}

export function createAiPanel(deps: AiPanelDeps): AiPanel {
  const app = document.getElementById('app')!;
  const splitter = node('div', 'ai-splitter');
  splitter.id = 'aiSplitter';
  splitter.tabIndex = 0;
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-label', 'Resize Flowgraph Copilot');
  splitter.setAttribute('aria-orientation', 'vertical');
  const dock = node('aside', 'ai-dock');
  dock.id = 'aiDock';
  dock.setAttribute('aria-label', 'Flowgraph Copilot');

  const header = node('div', 'ai-head');
  const heading = node('strong', '', 'Flowgraph Copilot');
  const cost = node('span', 'ai-cost', '$0.0000');
  const newChat = node('button', 'ai-icon', '＋');
  newChat.type = 'button'; newChat.title = 'New chat';
  newChat.setAttribute('aria-label', 'New chat');
  const settings = node('button', 'ai-icon', '⚙');
  settings.type = 'button'; settings.title = 'OpenRouter key and model';
  const close = node('button', 'ai-icon', '×');
  close.type = 'button'; close.title = 'Close Flowgraph Copilot';
  header.append(heading, cost, newChat, settings, close);

  const controls = node('div', 'ai-controls');
  const connection = node('div', 'ai-connection');
  const boundary = node('span', 'ai-boundary', 'Copilot API: openrouter.ai only');
  const disconnect = node('button', 'ai-disconnect', 'Disconnect') as HTMLButtonElement;
  disconnect.type = 'button';
  connection.append(boundary, disconnect);
  const modelSelect = node('select', 'ai-model') as HTMLSelectElement;
  modelSelect.setAttribute('aria-label', 'OpenRouter model');
  controls.append(connection, modelSelect);
  const transcript = node('div', 'ai-transcript');
  transcript.setAttribute('role', 'log');
  transcript.setAttribute('aria-live', 'polite');
  const form = node('form', 'ai-compose');
  const prompt = node('textarea', 'ai-prompt') as HTMLTextAreaElement;
  prompt.rows = 3;
  prompt.placeholder = 'Build an FM receiver, fix validation errors, diagnose a stalled graph…';
  const buttons = node('div', 'ai-compose-buttons');
  const send = node('button', 'run', 'Send') as HTMLButtonElement;
  send.type = 'submit';
  const stop = node('button', '', 'Stop') as HTMLButtonElement;
  stop.type = 'button'; stop.hidden = true;
  buttons.append(stop, send);
  form.append(prompt, buttons);
  dock.append(header, controls, transcript, form);
  app.append(splitter, dock);

  let models: OpenRouterModel[] = [];
  let key = hasConsent() ? storedKey() : '';
  let agent: FlowgraphAgent | null = null;
  let controller: AbortController | null = null;
  let activeAssistant: HTMLElement | null = null;
  let activeAssistantText: HTMLElement | null = null;
  let width = 420;
  const oauthReturn = takeOpenRouterOAuthReturn();
  let oauthRestore: Promise<GraphSnapshot | null> = Promise.resolve(null);

  const scrollDown = () => { transcript.scrollTop = transcript.scrollHeight; };
  const modelStatus = (label: string) => {
    const option = node('option', '', label) as HTMLOptionElement;
    option.value = '';
    return option;
  };
  const bubble = (role: 'user' | 'assistant' | 'status', text: string) => {
    const item = node('section', `ai-message ${role}`);
    const label = node('div', 'ai-role', role === 'user' ? 'You' : role === 'assistant' ? 'Copilot' : 'Status');
    const body = node('div', 'ai-message-body', text);
    item.append(label, body);
    transcript.appendChild(item);
    scrollDown();
    return { item, body };
  };

  const currentModel = () => modelSelect.value;
  const updateSend = () => {
    send.disabled = !!controller || modelSelect.disabled || !key || !currentModel();
    prompt.disabled = !!controller;
    disconnect.hidden = !key;
    newChat.disabled = !!controller || !key;
  };

  const toolRow = (name: string, payload: unknown) => {
    const details = node('details', 'ai-tool');
    const summary = node('summary', '', `Tool · ${name}`);
    const request = node('pre', 'ai-tool-payload');
    request.textContent = JSON.stringify(payload, null, 2);
    details.append(summary, request);
    transcript.appendChild(details);
    scrollDown();
    return details;
  };
  let currentTool: HTMLElement | null = null;

  const hooks: AgentHooks = {
    assistantStarted: () => {
      if (activeAssistant) return;
      const created = bubble('assistant', '');
      activeAssistant = created.item;
      activeAssistantText = created.body;
    },
    assistantDelta: chunk => {
      activeAssistantText?.appendChild(document.createTextNode(chunk));
      scrollDown();
    },
    toolStarted: (name, args) => { currentTool = toolRow(name, args); },
    toolFinished: (_name, result, error) => {
      if (!currentTool) return;
      const output = node('pre', `ai-tool-result${error ? ' error' : ''}`);
      output.textContent = JSON.stringify(result, null, 2);
      currentTool.appendChild(output);
      currentTool = null;
      scrollDown();
    },
    usage: (_usage, total) => { cost.textContent = `$${total.toFixed(4)}`; },
  };

  const askAuthorization = (
    authorization: RunAuthorization,
    runFromClick: () => Promise<string | null>,
    signal?: AbortSignal,
  ): Promise<string | null> => new Promise(resolve => {
    const row = node('div', 'ai-gesture');
    const copy = node('div');
    copy.append(node('strong', '', authorization.title), node('div', '', authorization.detail));
    const allow = node('button', 'run', authorization.button) as HTMLButtonElement;
    const dismiss = node('button', '', 'Dismiss') as HTMLButtonElement;
    allow.type = dismiss.type = 'button';
    let settled = false;
    let timer = 0;
    const settle = (token: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      row.remove();
      resolve(token);
    };
    allow.onclick = () => {
      allow.disabled = dismiss.disabled = true;
      // The call begins in this click handler, preserving transient activation.
      void runFromClick().then(settle, () => settle(null));
    };
    dismiss.onclick = () => settle(null);
    timer = window.setTimeout(() => settle(null), 60_000);
    if (signal?.aborted) settle(null);
    else signal?.addEventListener('abort', () => settle(null), { once: true });
    row.append(copy, allow, dismiss);
    transcript.appendChild(row);
    scrollDown();
  });

  const fullToolDeps: AiToolDeps = {
    ...deps.toolDeps,
    runFlowgraph: (seconds, signal) => runFlowgraph({
      ...deps.harness,
      requestAuthorization: askAuthorization,
    }, seconds, signal),
  };

  const rebuildAgent = () => {
    agent = key && currentModel() ? new FlowgraphAgent({
      key,
      model: currentModel(),
      systemPrompt: `${deps.systemPrompt.trim()}\n\nRunnable block index:\n${runnableIndex(deps.entries())}`,
      deps: fullToolDeps,
      hooks,
    }) : null;
    updateSend();
  };

  const resetConversation = (announcement: string) => {
    transcript.textContent = '';
    prompt.value = '';
    cost.textContent = '$0.0000';
    activeAssistant = activeAssistantText = currentTool = null;
    rebuildAgent();
    bubble('status', announcement);
    prompt.focus();
  };

  const populateModels = () => {
    const saved = storedModel();
    const wanted = models.some(model => model.id === saved)
      ? saved
      : DEFAULT_OPENROUTER_MODEL;
    modelSelect.textContent = '';
    const placeholder = node('option', '', 'Choose a tool-capable model…') as HTMLOptionElement;
    placeholder.value = '';
    modelSelect.appendChild(placeholder);
    for (const model of models) {
      const option = node('option') as HTMLOptionElement;
      option.value = model.id;
      option.textContent = `${model.name} · ${(model.contextLength / 1000).toFixed(0)}k` +
        (model.id === DEFAULT_OPENROUTER_MODEL ? ' · default' : '');
      modelSelect.appendChild(option);
    }
    if (wanted && models.some(model => model.id === wanted)) modelSelect.value = wanted;
    rebuildAgent();
  };

  const loadModels = async () => {
    if (models.length) return;
    modelSelect.textContent = '';
    modelSelect.appendChild(modelStatus('Loading models…'));
    modelSelect.disabled = true;
    try { models = await listModels(); populateModels(); }
    catch (error) {
      modelSelect.textContent = '';
      modelSelect.appendChild(modelStatus('Could not load models'));
      bubble('status', error instanceof Error ? error.message : String(error));
    } finally { modelSelect.disabled = false; updateSend(); }
  };

  const showConnect = () => {
    let keyInput!: HTMLInputElement;
    let consent!: HTMLInputElement;
    let remember!: HTMLInputElement;
    let connectStatus!: HTMLElement;
    let manual!: HTMLDetailsElement;
    const overlay = deps.openDialog('Connect OpenRouter', body => {
      const trust = node('section', 'ai-trust');
      trust.append(
        node('strong', '', 'Your key stays on this device'),
        node('p', '', 'GNU Radio World is a static, open-source application. It has no application server that receives your key. Your browser sends the key only to openrouter.ai over HTTPS when Copilot makes a request.'),
        node('p', '', 'The key is never placed in a flowgraph, share link, URL, console message, or runner message.'),
      );
      const sent = node('section', 'ai-data-boundary');
      sent.append(
        node('strong', '', 'What the AI receives'),
        node('p', '', 'Your prompt, current flowgraph, relevant block metadata, tool results, and console output captured while diagnosing a run. OpenRouter sends that content—not your OpenRouter key—to the selected model provider.'),
      );
      const links = node('div', 'ai-trust-links');
      // This is the same disclosed API boundary, linked so the user can cap it.
      // pr-security-scan: allow new-outbound-host
      const openRouterSite = 'https://openrouter.ai';
      const limited = node('a', '', 'Create a dedicated, limited key');
      limited.href = `${openRouterSite}/settings/keys`;
      limited.target = '_blank'; limited.rel = 'noopener noreferrer';
      const source = node('a', '', 'Inspect the source');
      source.href = 'https://github.com/777arc/gnuradio-world/blob/main/editor/src/ai/openrouter.ts';
      source.target = '_blank'; source.rel = 'noopener noreferrer';
      const privacy = node('a', '', 'OpenRouter privacy controls');
      privacy.href = `${openRouterSite}/docs/guides/privacy/data-collection`;
      privacy.target = '_blank'; privacy.rel = 'noopener noreferrer';
      links.append(limited, source, privacy);
      body.append(trust, sent, links);

      remember = node('input') as HTMLInputElement;
      remember.type = 'checkbox'; remember.checked = keyIsRemembered();
      const rememberLabel = node('label', 'ai-consent');
      rememberLabel.append(remember,
        document.createTextNode(' Remember the key on this device. Leave unchecked to keep it only for this browser tab.'));

      consent = node('input') as HTMLInputElement;
      consent.type = 'checkbox'; consent.checked = hasConsent();
      const consentLabel = node('label', 'ai-consent');
      consentLabel.append(consent, document.createTextNode(
        ' I understand what is sent to OpenRouter and the selected model provider.'));
      body.append(rememberLabel, consentLabel);

      connectStatus = node('p', 'ai-connect-status');
      body.appendChild(connectStatus);

      manual = node('details', 'ai-manual-key');
      const summary = node('summary', '', 'Paste an API key instead');
      const label = node('label', 'ai-key-label', 'OpenRouter API key');
      keyInput = node('input', 'ai-key') as HTMLInputElement;
      keyInput.type = 'password'; keyInput.autocomplete = 'off';
      keyInput.placeholder = key ? 'Enter a replacement key' : 'sk-or-v1-…';
      label.appendChild(keyInput);
      manual.append(summary, label);
      body.appendChild(manual);
    });
    const connect = node('button', 'run', 'Connect with OpenRouter') as HTMLButtonElement;
    connect.type = 'button';
    connect.onclick = async () => {
      if (!consent.checked) { consent.focus(); return; }
      connect.disabled = true;
      connectStatus.textContent = 'Opening OpenRouter…';
      storeConsent();
      try {
        await beginOpenRouterOAuth(JSON.stringify(deps.snapshot()), remember.checked);
      } catch (error) {
        connect.disabled = false;
        connectStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    };
    const save = node('button', '', 'Use pasted key') as HTMLButtonElement;
    save.type = 'button';
    save.onclick = () => {
      if (!keyInput.value.trim()) { manual.open = true; keyInput.focus(); return; }
      if (!consent.checked) { consent.focus(); return; }
      key = keyInput.value.trim();
      storeKey(key, remember.checked); storeConsent();
      overlay.remove();
      rebuildAgent();
      void loadModels();
    };
    overlay.querySelector('.dlgfoot')?.prepend(connect, save);
    connect.focus();
  };

  const attachDiff = (before: GraphSnapshot, after: GraphSnapshot) => {
    if (!activeAssistant || same(before, after)) return;
    const lines = graphDiff(before, after);
    const details = node('details', 'ai-diff');
    const summary = node('summary', '', `Canvas changes · ${lines.length}`);
    const list = node('ul');
    for (const line of lines) list.appendChild(node('li', '', line));
    const revert = node('button', '', 'Revert this turn') as HTMLButtonElement;
    revert.type = 'button';
    revert.onclick = () => {
      deps.restoreSnapshot(clone(before), true);
      revert.disabled = true;
      revert.textContent = 'Reverted';
    };
    details.append(summary, list, revert);
    activeAssistant.appendChild(details);
  };

  const finishBusy = () => {
    controller = null;
    stop.hidden = true;
    activeAssistant = activeAssistantText = currentTool = null;
    updateSend();
    prompt.focus();
  };

  form.onsubmit = async event => {
    event.preventDefault();
    const text = prompt.value.trim();
    if (!text || controller) return;
    if (!key) { showConnect(); return; }
    if (!currentModel()) { modelSelect.focus(); return; }
    if (!agent) rebuildAgent();
    bubble('user', text);
    prompt.value = '';
    const before = deps.snapshot();
    controller = new AbortController();
    stop.hidden = false;
    updateSend();
    try {
      await agent!.turn(text, controller.signal);
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (!aborted) bubble('status', error instanceof Error ? error.message : String(error));
      else bubble('status', 'Stopped.');
    } finally {
      const after = deps.snapshot();
      if (!same(before, after)) {
        deps.commitHistory();
        attachDiff(before, after);
      }
      finishBusy();
    }
  };

  stop.onclick = () => controller?.abort();
  newChat.onclick = () => {
    if (!controller && key) resetConversation('New conversation started.');
  };
  settings.onclick = showConnect;
  disconnect.onclick = () => {
    forgetKey();
    key = '';
    agent = null;
    bubble('status', 'OpenRouter disconnected and its key was removed from this browser.');
    updateSend();
  };
  close.onclick = () => app.classList.add('ai-hidden');
  modelSelect.onchange = () => {
    storeModel(currentModel());
    if (currentModel()) resetConversation(`New conversation using ${currentModel()}.`);
    else rebuildAgent();
  };
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  let resizing = false;
  splitter.addEventListener('pointerdown', event => {
    resizing = true;
    splitter.setPointerCapture(event.pointerId);
    app.classList.add('resizing-ai');
  });
  splitter.addEventListener('pointermove', event => {
    if (!resizing) return;
    width = Math.max(300, Math.min(760, window.innerWidth - event.clientX));
    app.style.setProperty('--ai-width', `${width}px`);
  });
  const finishResize = (event: PointerEvent) => {
    resizing = false;
    app.classList.remove('resizing-ai');
    if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
  };
  splitter.addEventListener('pointerup', finishResize);
  splitter.addEventListener('pointercancel', finishResize);

  app.classList.add('ai-hidden');
  modelSelect.appendChild(modelStatus('Open Copilot to load models…'));
  if (!key) bubble('status', 'Connect OpenRouter to start. No API key is bundled with GNU Radio World.');
  updateSend();

  if (oauthReturn) {
    app.classList.remove('ai-hidden');
    bubble('status', 'Finishing the secure OpenRouter connection…');
    oauthRestore = (async () => {
      let state: GraphSnapshot | null = null;
      try {
        const parsed = JSON.parse(oauthReturn.graphState || 'null');
        if (parsed && Array.isArray(parsed.insts) && Array.isArray(parsed.conns) &&
            Number.isFinite(Number(parsed.counter))) state = parsed as GraphSnapshot;
      } catch { /* The connection can still complete without restoring the canvas. */ }
      try {
        if (!oauthReturn.code || !oauthReturn.verifier)
          throw new Error('OpenRouter returned without a complete authorization code');
        key = await exchangeOpenRouterCode(oauthReturn.code, oauthReturn.verifier);
        storeKey(key, oauthReturn.remember);
        storeConsent();
        rebuildAgent();
        void loadModels();
        bubble('status', oauthReturn.remember
          ? 'Connected to OpenRouter. The key is remembered on this device.'
          : 'Connected to OpenRouter. The key will be forgotten when this browser tab closes.');
      } catch (error) {
        bubble('status', error instanceof Error ? error.message : String(error));
      }
      return state;
    })();
  }

  const openPanel = () => {
    app.classList.remove('ai-hidden');
    if (!key) showConnect();
    else { void loadModels(); prompt.focus(); }
  };

  return {
    open: openPanel,
    close: () => app.classList.add('ai-hidden'),
    toggle: () => app.classList.contains('ai-hidden') ? openPanel() : app.classList.add('ai-hidden'),
    isOpen: () => !app.classList.contains('ai-hidden'),
    isOAuthReturn: () => !!oauthReturn,
    oauthRestore: () => oauthRestore,
  };
}
