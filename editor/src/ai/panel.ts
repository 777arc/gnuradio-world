import type { GraphSnapshot, Inst } from '../graph-model';
import { runnableIndex, type CatalogEntry } from './catalog';
import { FlowgraphAgent, type AgentHooks } from './agent';
import {
  beginOpenRouterOAuth,
  exchangeOpenRouterCode,
  takeOpenRouterOAuthReturn,
} from './openrouter';
import { AiRequestError, listModels, type AiModel } from './client';
import {
  PROVIDER_IDS,
  forgetKey,
  hasConsent,
  keyIsRemembered,
  providerFor,
  storeConsent,
  storeKey,
  storeModel,
  storeProvider,
  storedKey,
  storedModel,
  storedProvider,
  type ProviderId,
} from './providers';
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
  settings.type = 'button'; settings.title = 'API key and model';
  const close = node('button', 'ai-icon', '×');
  close.type = 'button'; close.title = 'Close Flowgraph Copilot';
  header.append(heading, cost, newChat, settings, close);

  const controls = node('div', 'ai-controls');
  const connection = node('div', 'ai-connection');
  const boundary = node('span', 'ai-boundary', '');
  const disconnect = node('button', 'ai-disconnect', 'Disconnect') as HTMLButtonElement;
  disconnect.type = 'button';
  connection.append(boundary, disconnect);
  const providerSelect = node('select', 'ai-provider') as HTMLSelectElement;
  providerSelect.setAttribute('aria-label', 'AI provider');
  for (const id of PROVIDER_IDS) {
    const option = node('option', '', providerFor(id).menuLabel) as HTMLOptionElement;
    option.value = id;
    providerSelect.appendChild(option);
  }
  const modelSelect = node('select', 'ai-model') as HTMLSelectElement;
  modelSelect.setAttribute('aria-label', 'Model');
  controls.append(connection, providerSelect, modelSelect);
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

  let providerId: ProviderId = storedProvider();
  const provider = () => providerFor(providerId);
  // Each provider keeps its own list; switching back must not refetch.
  const modelCache = new Map<ProviderId, AiModel[]>();
  let models: AiModel[] = [];
  let key = hasConsent(providerId) ? storedKey(providerId) : '';
  /**
   * Whether the dock can send at all. The shared provider holds no key of the
   * user's, so "connected" there means nothing more than having a model.
   */
  const ready = () => provider().keyless || !!key;
  // Tracked apart from `modelSelect.disabled`, which is also how a fixed,
  // single-model picker is locked — and a locked picker must not disable Send.
  let modelsLoading = false;
  let spend = 0;
  // Totalled apart, because one number cannot distinguish cheap cached input
  // from full-price fresh input from output spent reasoning.
  const usageTotals = { prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0 };
  const clearUsage = () => {
    spend = 0;
    usageTotals.prompt = usageTotals.completion = 0;
    usageTotals.cached = usageTotals.reasoning = usageTotals.total = 0;
  };
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
  // The shared provider is two hops, and the line says so rather than naming
  // only the host the browser happens to talk to.
  const boundaryText = () => provider().keyless
    ? `Copilot API: ${provider().host} → ${providerFor('openai').host} (shared key)`
    : `Copilot API: ${provider().host} only`;
  const share = (part: number, whole: number) =>
    whole > 0 ? ` (${Math.round((part / whole) * 100)}%)` : '';
  // OpenRouter prices every request in its final usage event; OpenAI reports
  // token counts only, so that is what the header shows there. Either headline
  // hides the split that decides the bill, so the breakdown is on hover.
  const showSpend = () => {
    const named = provider();
    cost.textContent = named.reportsCost
      ? `$${spend.toFixed(4)}`
      : `${usageTotals.total.toLocaleString()} tokens`;
    const headline = named.reportsCost
      ? 'Spend on this conversation'
      : `Tokens used in this conversation (${named.label} reports no cost)`;
    cost.title = usageTotals.total ? [
      headline,
      `Input ${usageTotals.prompt.toLocaleString()} · ` +
        `${usageTotals.cached.toLocaleString()} cached${share(usageTotals.cached, usageTotals.prompt)}`,
      `Output ${usageTotals.completion.toLocaleString()} · ` +
        `${usageTotals.reasoning.toLocaleString()} reasoning${share(usageTotals.reasoning, usageTotals.completion)}`,
    ].join('\n') : headline;
  };
  const updateSend = () => {
    send.disabled = !!controller || modelsLoading || !ready() || !currentModel();
    prompt.disabled = !!controller;
    // Nothing to disconnect where nothing of the user's was stored.
    disconnect.hidden = provider().keyless || !key;
    newChat.disabled = !!controller || !ready();
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

  const ensureAssistant = (): HTMLElement => {
    if (activeAssistant) return activeAssistant;
    const created = bubble('assistant', '');
    activeAssistant = created.item;
    activeAssistantText = created.body;
    return created.item;
  };

  const hooks: AgentHooks = {
    // A round's prose belongs below the tool calls it followed, so a round only
    // clears the previous bubble and the first token creates the next one, at
    // the bottom of the transcript as it stands then. Creating it up front
    // instead put a turn's closing answer above every tool call of every round
    // after the first, off screen, and left an empty bubble behind whenever a
    // round called tools and said nothing.
    assistantStarted: () => { activeAssistant = activeAssistantText = null; },
    assistantDelta: chunk => {
      ensureAssistant();
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
    usage: (used, total) => {
      spend = total;
      const prompt = Number(used.prompt_tokens || 0);
      const completion = Number(used.completion_tokens || 0);
      usageTotals.prompt += prompt;
      usageTotals.completion += completion;
      usageTotals.cached += Number(used.cached_tokens || 0);
      usageTotals.reasoning += Number(used.reasoning_tokens || 0);
      usageTotals.total += Number(used.total_tokens || prompt + completion);
      showSpend();
    },
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
    agent = ready() && currentModel() ? new FlowgraphAgent({
      provider: providerId,
      key: key || undefined,
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
    clearUsage();
    showSpend();
    activeAssistant = activeAssistantText = currentTool = null;
    rebuildAgent();
    bubble('status', announcement);
    prompt.focus();
  };

  const populateModels = () => {
    const named = provider();
    // One model and no choice: the shared key is only accepted for this id, so
    // the picker states it and locks rather than offering a request that the
    // proxy would refuse.
    if (named.fixedModels) {
      modelSelect.textContent = '';
      for (const model of named.fixedModels) {
        const option = node('option') as HTMLOptionElement;
        option.value = model.id;
        option.textContent = model.name;
        modelSelect.appendChild(option);
      }
      modelSelect.value = named.fixedModels[0]?.id || '';
      modelSelect.disabled = true;
      modelSelect.title =
        `${named.label} runs one model. Connect your own key to choose another.`;
      rebuildAgent();
      return;
    }
    modelSelect.disabled = false;
    modelSelect.title = '';
    const fallback = provider().defaultModel;
    const saved = storedModel(providerId);
    const wanted = models.some(model => model.id === saved) ? saved : fallback;
    modelSelect.textContent = '';
    const placeholder = node('option', '', 'Choose a tool-capable model…') as HTMLOptionElement;
    placeholder.value = '';
    modelSelect.appendChild(placeholder);
    for (const model of models) {
      const option = node('option') as HTMLOptionElement;
      option.value = model.id;
      // OpenAI publishes no context length with its list, so it is named only
      // where the provider actually reports one.
      option.textContent = model.name +
        (model.contextLength ? ` · ${(model.contextLength / 1000).toFixed(0)}k` : '') +
        (model.id === fallback ? ' · default' : '');
      modelSelect.appendChild(option);
    }
    if (wanted && models.some(model => model.id === wanted)) modelSelect.value = wanted;
    rebuildAgent();
  };

  const loadModels = async () => {
    // A fixed list is in the descriptor already; nothing is ever fetched.
    if (provider().fixedModels) {
      models = provider().fixedModels!.map(model => ({ ...model }));
      populateModels();
      return;
    }
    const cached = modelCache.get(providerId);
    if (cached?.length) { models = cached; populateModels(); return; }
    // OpenAI's list is authenticated; there is nothing to fetch before connecting.
    if (provider().modelsNeedKey && !key) {
      modelSelect.textContent = '';
      modelSelect.appendChild(modelStatus(`Connect ${provider().label} to load models…`));
      updateSend();
      return;
    }
    const requested = providerId;
    modelSelect.textContent = '';
    modelSelect.appendChild(modelStatus('Loading models…'));
    modelSelect.disabled = true;
    modelsLoading = true;
    try {
      const listed = await listModels({ provider: requested, key });
      modelCache.set(requested, listed);
      // The user may have switched providers while this was in flight.
      if (requested !== providerId) return;
      models = listed;
      populateModels();
    }
    catch (error) {
      if (requested !== providerId) return;
      modelSelect.textContent = '';
      modelSelect.appendChild(modelStatus('Could not load models'));
      bubble('status', error instanceof Error ? error.message : String(error));
    } finally { modelsLoading = false; modelSelect.disabled = false; updateSend(); }
  };

  /** Points the dock at one provider's key, model list, and data boundary. */
  const applyProvider = (id: ProviderId, announce: boolean) => {
    providerId = id;
    storeProvider(id);
    providerSelect.value = id;
    boundary.textContent = boundaryText();
    key = hasConsent(id) ? storedKey(id) : '';
    models = modelCache.get(id) || [];
    modelSelect.textContent = '';
    modelSelect.disabled = false;
    modelSelect.appendChild(modelStatus(
      ready() ? 'Loading models…' : `Connect ${provider().label}…`));
    clearUsage();
    showSpend();
    if (announce) {
      resetConversation(provider().keyless
        ? `Using the free ${provider().label} model, shared by everyone on the site.`
        : `Using the ${provider().label} API.`);
    } else rebuildAgent();
    if (ready()) void loadModels();
    else updateSend();
  };

  const showConnect = () => {
    // The dialog can switch providers, so its provider-specific copy, links,
    // and buttons are (re)written by applyDialogProvider below.
    let dialogProvider = providerId;
    let keyInput!: HTMLInputElement;
    let consent!: HTMLInputElement;
    let remember!: HTMLInputElement;
    let connectStatus!: HTMLElement;
    let manual!: HTMLDetailsElement;
    let manualSummary!: HTMLElement;
    let keyLabel!: HTMLElement;
    let keyLabelText!: Text;
    let choice!: HTMLSelectElement;
    let keyCopy!: HTMLElement;
    let trustHeading!: Text;
    let rememberLabel!: HTMLElement;
    let sentCopy!: HTMLElement;
    let consentText!: Text;
    let limited!: HTMLAnchorElement;
    let privacy!: HTMLAnchorElement;
    const overlay = deps.openDialog('Connect an AI provider', body => {
      const pick = node('label', 'ai-key-label', 'AI provider');
      choice = node('select', 'ai-model') as HTMLSelectElement;
      for (const id of PROVIDER_IDS) {
        const option = node('option', '', providerFor(id).label) as HTMLOptionElement;
        option.value = id;
        choice.appendChild(option);
      }
      choice.value = dialogProvider;
      pick.appendChild(choice);
      body.appendChild(pick);

      const trust = node('section', 'ai-trust');
      keyCopy = node('p', '', '');
      trustHeading = document.createTextNode('');
      const trustTitle = node('strong');
      trustTitle.appendChild(trustHeading);
      trust.append(
        trustTitle,
        keyCopy,
        node('p', '', 'A key is never placed in a flowgraph, share link, URL, console message, or runner message.'),
      );
      const sent = node('section', 'ai-data-boundary');
      sentCopy = node('p', '', '');
      sent.append(node('strong', '', 'What the AI receives'), sentCopy);
      const links = node('div', 'ai-trust-links');
      limited = node('a', '', 'Create a dedicated, limited key');
      limited.target = '_blank'; limited.rel = 'noopener noreferrer';
      const source = node('a', '', 'Inspect the source');
      source.href = 'https://github.com/777arc/gnuradio-world/blob/main/editor/src/ai/client.ts';
      source.target = '_blank'; source.rel = 'noopener noreferrer';
      privacy = node('a', '', '');
      privacy.target = '_blank'; privacy.rel = 'noopener noreferrer';
      links.append(limited, source, privacy);
      body.append(trust, sent, links);

      remember = node('input') as HTMLInputElement;
      remember.type = 'checkbox';
      rememberLabel = node('label', 'ai-consent');
      rememberLabel.append(remember,
        document.createTextNode(' Remember the key on this device. Leave unchecked to keep it only for this browser tab.'));

      consent = node('input') as HTMLInputElement;
      consent.type = 'checkbox';
      const consentLabel = node('label', 'ai-consent');
      consentText = document.createTextNode('');
      consentLabel.append(consent, consentText);
      body.append(rememberLabel, consentLabel);

      connectStatus = node('p', 'ai-connect-status');
      body.appendChild(connectStatus);

      manual = node('details', 'ai-manual-key');
      manualSummary = node('summary', '', 'Paste an API key instead');
      keyLabel = node('label', 'ai-key-label');
      keyLabelText = document.createTextNode('');
      keyInput = node('input', 'ai-key') as HTMLInputElement;
      keyInput.type = 'password'; keyInput.autocomplete = 'off';
      keyLabel.append(keyLabelText, keyInput);
      manual.append(manualSummary, keyLabel);
      body.appendChild(manual);
    });
    const connect = node('button', 'run', 'Connect with OpenRouter') as HTMLButtonElement;
    connect.type = 'button';
    const save = node('button', '', 'Use pasted key') as HTMLButtonElement;
    save.type = 'button';

    const applyDialogProvider = () => {
      const chosen = providerFor(dialogProvider);
      const connected = hasConsent(dialogProvider) ? storedKey(dialogProvider) : '';
      trustHeading.nodeValue = chosen.keyless
        ? 'No API key needed'
        : 'Your key stays on this device';
      keyCopy.textContent = chosen.keyless
        ? 'GNU Radio World is a static, open-source application. This model runs on one ' +
          `OpenAI key the project shares with every visitor, held by a Cloudflare Worker at ` +
          `${chosen.host} — nothing of yours is stored, and you have nothing to disconnect. ` +
          'Use is limited per visitor and against a daily budget for the whole site, so a busy ' +
          'day can run it out until it resets at 00:00 UTC. Connect your own key for limits of ' +
          'your own.'
        : 'GNU Radio World is a static, open-source application. It has no ' +
          'application server that receives your key. Your browser sends the key only to ' +
          `${chosen.host} over HTTPS when Copilot makes a request.`;
      sentCopy.textContent = chosen.sends;
      limited.href = chosen.keysUrl;
      limited.textContent = chosen.keysLabel;
      privacy.href = chosen.privacyUrl;
      privacy.textContent = chosen.privacyLabel;
      consentText.nodeValue = chosen.keyless
        ? ' I understand my prompt and flowgraph are sent to the GNU Radio World proxy and on ' +
          'to OpenAI.'
        : chosen.oauth
          ? ` I understand what is sent to ${chosen.label} and the selected model provider.`
          : ` I understand what is sent to ${chosen.label}.`;
      remember.checked = keyIsRemembered(dialogProvider);
      consent.checked = hasConsent(dialogProvider);
      keyLabelText.nodeValue = `${chosen.label} API key`;
      keyInput.value = '';
      keyInput.placeholder = connected ? 'Enter a replacement key' : chosen.keyPlaceholder;
      connectStatus.textContent = '';
      // Only OpenRouter has a browser authorization flow; an OpenAI key is
      // pasted; the shared proxy takes no key at all.
      connect.hidden = !chosen.oauth;
      connect.disabled = false;
      connect.textContent = `Connect with ${chosen.label}`;
      manualSummary.hidden = !chosen.oauth;
      manual.hidden = chosen.keyless;
      manual.open = !chosen.oauth && !chosen.keyless;
      rememberLabel.hidden = chosen.keyless;
      save.textContent = chosen.keyless
        ? 'Use the free shared model'
        : chosen.oauth ? 'Use pasted key' : `Use ${chosen.label} key`;
    };

    choice.onchange = () => {
      dialogProvider = providerFor(choice.value).id;
      applyDialogProvider();
    };
    connect.onclick = async () => {
      if (!consent.checked) { consent.focus(); return; }
      connect.disabled = true;
      connectStatus.textContent = 'Opening OpenRouter…';
      storeConsent('openrouter');
      storeProvider('openrouter');
      try {
        await beginOpenRouterOAuth(JSON.stringify(deps.snapshot()), remember.checked);
      } catch (error) {
        connect.disabled = false;
        connectStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    };
    save.onclick = () => {
      if (!consent.checked) { consent.focus(); return; }
      if (providerFor(dialogProvider).keyless) {
        // Consent is the whole of connecting here; there is no key to store.
        storeConsent(dialogProvider);
        overlay.remove();
        if (dialogProvider !== providerId) applyProvider(dialogProvider, true);
        else { rebuildAgent(); void loadModels(); }
        return;
      }
      if (!keyInput.value.trim()) { manual.open = true; keyInput.focus(); return; }
      const entered = keyInput.value.trim();
      storeKey(dialogProvider, entered, remember.checked);
      storeConsent(dialogProvider);
      overlay.remove();
      if (dialogProvider !== providerId) {
        // Picks the stored key up along with the rest of that provider's state,
        // and says which API the conversation now runs against.
        applyProvider(dialogProvider, true);
      } else {
        key = entered;
        rebuildAgent();
        void loadModels();
      }
    };
    applyDialogProvider();
    overlay.querySelector('.dlgfoot')?.prepend(connect, save);
    (connect.hidden ? (manual.hidden ? save : keyInput) : connect).focus();
  };

  const attachDiff = (before: GraphSnapshot, after: GraphSnapshot) => {
    if (same(before, after)) return;
    // A turn that edited the canvas and ended without prose still needs
    // somewhere to hang Revert.
    const host = ensureAssistant();
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
    host.appendChild(details);
    scrollDown();
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
    // Consent is what the first Send waits on. The dock is usable before it —
    // the free shared model needs no connecting — but nothing leaves the
    // browser until the dialog has said where it goes.
    if (!hasConsent(providerId) || !ready()) { showConnect(); return; }
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
      if (aborted) bubble('status', 'Stopped.');
      else {
        bubble('status', error instanceof Error ? error.message : String(error));
        // The shared model's limits are the one failure a user can act on
        // without leaving the page, so the way out is named alongside it.
        if (error instanceof AiRequestError && error.rateLimited && provider().keyless) {
          bubble('status', 'Switch the provider above to OpenRouter or OpenAI to use a key of ' +
            'your own, which has limits of its own.');
        }
      }
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
    if (!controller && ready()) resetConversation('New conversation started.');
  };
  settings.onclick = showConnect;
  disconnect.onclick = () => {
    const label = provider().label;
    forgetKey(providerId);
    key = '';
    agent = null;
    // An authenticated list belongs to the key that read it.
    if (provider().modelsNeedKey) modelCache.delete(providerId);
    bubble('status', `${label} disconnected and its key was removed from this browser.`);
    updateSend();
  };
  close.onclick = () => app.classList.add('ai-hidden');
  providerSelect.onchange = () => {
    if (controller) { providerSelect.value = providerId; return; }
    const chosen = providerFor(providerSelect.value).id;
    if (chosen === providerId) return;
    applyProvider(chosen, true);
    if (!ready()) showConnect();
  };
  modelSelect.onchange = () => {
    storeModel(providerId, currentModel());
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
  providerSelect.value = providerId;
  boundary.textContent = boundaryText();
  showSpend();
  modelSelect.appendChild(modelStatus('Open Copilot to load models…'));
  if (provider().keyless) {
    bubble('status', `Free to use — ${provider().label} runs ${provider().defaultModel} on a ` +
      'shared key, rate limited per visitor. Connect your own OpenRouter or OpenAI key above ' +
      'for limits of your own.');
  } else if (!key) {
    bubble('status',
      `Connect ${provider().label} to start. No API key is bundled with GNU Radio World.`);
  }
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
        const granted = await exchangeOpenRouterCode(oauthReturn.code, oauthReturn.verifier);
        storeKey('openrouter', granted, oauthReturn.remember);
        storeConsent('openrouter');
        // The redirect can land on a session that had switched to OpenAI.
        if (providerId !== 'openrouter') applyProvider('openrouter', false);
        key = granted;
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
    // A keyless provider has nothing to connect, so the dialog waits for the
    // first Send rather than interrupting someone who only opened the dock.
    if (!ready()) showConnect();
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
