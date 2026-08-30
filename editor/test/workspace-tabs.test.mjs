import assert from 'node:assert/strict';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

assert.match(html,
  /id="workspaceTabs"[^>]*role="tablist"[\s\S]*id="tabEditor"[^>]*role="tab"[\s\S]*id="tabQtGui"[^>]*role="tab"/,
  'the right-side workspace exposes Editor and QT GUI tabs');
assert.match(html,
  /id="workspaceContent"[\s\S]*id="editorPane"[^>]*role="tabpanel"[\s\S]*id="runPane"[^>]*role="tabpanel"[\s\S]*<\/section>[\s\S]*?<\/div>\s*<div id="consoleSplitter"[\s\S]*?<div id="log">/,
  'the console is a persistent row below both tab panels');
assert.match(html, /#editorPane\[hidden\], #runPane\[hidden\] \{ display:none; \}/,
  'panel-specific display rules cannot override the inactive tab hidden state');
assert.match(html, /id="tabQtGui"[\s\S]*id="runIndicator"/,
  'the QT GUI tab includes a running-state indicator');
assert.match(html, /#workspace\.running #runIndicator \{[^}]*opacity:1/,
  'the running-state indicator is visible while a flowgraph runs');
assert.match(html, /\.workspace-tab \{[^}]*flex:none;[^}]*padding:9px 12px/,
  'workspace tabs must hug their text instead of filling the tab strip');
assert.doesNotMatch(html, /\.workspace-tab \{[^}]*min-width:/,
  'workspace tabs must not retain a fixed minimum width');
assert.match(html, /\.paltabs \{[^}]*background:#1b1e29;[^}]*overflow-x:auto/,
  'the palette tab strip must leave a blank background after its tabs and scroll when needed');
assert.match(html, /\.paltab \{[^}]*flex:none;[^}]*padding:9px 12px/,
  'palette tabs must hug their text instead of sharing the full pane width');

assert.match(source,
  /activate\(tab: WorkspaceTab\)[\s\S]*this\.deps\.editorPane\.hidden[\s\S]*this\.deps\.runnerPane\.hidden/,
  'workspace tab activation swaps the editor and QT GUI panels');
assert.match(source,
  /deps\.setRunnerRunning\(true\);\s*deps\.activateWorkspaceTab\('qtgui'\);/,
  'executing a flowgraph selects the QT GUI tab and marks it running');
assert.match(source, /qtTab\.setAttribute\('aria-label', qtLabel\)/,
  'the QT GUI running state is also exposed to assistive technology');
assert.match(source,
  /function stopFlowgraph[\s\S]*deps\.setRunnerRunning\(false\);\s*deps\.activateWorkspaceTab\('editor'\);/,
  'stopping a flowgraph clears the QT GUI running state and returns to the editor');
assert.match(source,
  /e\.origin !== location\.origin[\s\S]*e\.source !== runnerFrame\.contentWindow[\s\S]*d\.recordingToken !== runSessionState\.activeToken/,
  'runner messages must come from the current same-origin frame and carry its run token');
assert.match(source,
  /d\.type === 'gr-error'[\s\S]*log\(`run failed:[\s\S]*stop\(\);[\s\S]*setRunnerRunning\(false, 'Flowgraph failed'\)/,
  'a runner startup failure stops and unloads the failed runner before clearing its indicator');

// ---- Graham right dock ----------------------------------------------------
assert.match(html,
  /#app \{[^}]*--ai-width:420px;[^}]*--ai-toggle-width:40px;[^}]*grid-template-columns:[^}]*var\(--ai-splitter-width\) var\(--ai-width\) var\(--ai-toggle-width\)/,
  'the desktop shell reserves a resizable Graham dock and persistent right rail');
assert.match(html,
  /#app\.ai-hidden \{ --ai-width:0px !important; --ai-splitter-width:0px !important; \}/,
  'closing a resized Graham dock overrides its inline width and leaves no empty grid track');
assert.match(source,
  /const paletteReady = buildPalette\(\);\s*void paletteReady\.then\(initializeAiPanel\)/,
  'Graham initializes against the complete generated block catalog');
assert.match(source,
  /const toggle = node\('button', 'ai-toggle'\)[\s\S]*aria-controls[\s\S]*setPanelOpen\(false\)[\s\S]*toggle\.onclick = togglePanel/,
  'the right-side Graham rail starts collapsed and opens the dock directly');
assert.match(source,
  /toggleIconBefore = node\('span', 'ai-toggle-icon', '✨'\)[\s\S]*toggle\.append\(toggleIconBefore, node\('span', 'ai-toggle-label', 'Graham'\), toggleIconAfter\)/,
  'sparkle icons flank Graham on the collapsed rail');
assert.match(source,
  /setPanelOpen[\s\S]*aria-expanded[\s\S]*open \? 'Close Graham' : 'Open Graham'/,
  'the Graham rail exposes its current state and action to assistive technology');
assert.match(source,
  /const close = node\('button', 'ai-icon', '×'\)[\s\S]*close\.onclick = closePanel/,
  'the expanded Graham dock closes from its header');
assert.match(html,
  /#app:not\(\.ai-hidden\) \{ --ai-toggle-width:0px; \}[\s\S]*#app:not\(\.ai-hidden\) \.ai-toggle \{ display:none; \}/,
  'the vertical Graham rail and its grid column disappear while the dock is open');
assert.match(source,
  /const heading = node\('strong', '', 'Graham'\);[\s\S]*const expansion = node\('span', 'ai-name-expansion',\s*'GNU Radio Assistant for Hams And Mortals'\)/,
  'the Graham header explains its name in plain text on the next line');
assert.doesNotMatch(source, /ai-acronym|node\('strong', '', '[GRAHAM]'\)/,
  'the Graham expansion has no separate acronym or bold initial letters');
assert.match(source,
  /const balance = node\('span', 'ai-balance'\)[\s\S]*header\.append\(title, balance, cost, newChat, settings, close\)/,
  'a signed-in prepaid balance remains visible in Graham’s persistent header');
assert.match(source,
  /How would you like to use Graham\?[\s\S]*Use the free shared option[\s\S]*Bring your own OpenAI API key[\s\S]*Pay through GNU Radio World/,
  'first-use onboarding explains Graham’s three payment methods');
assert.match(source,
  /A few million tokens per day are shared across everyone using GNU Radio World, so this option is likely to be unavailable\./,
  'the free option clearly warns that its site-wide allowance may be exhausted');
assert.match(source,
  /let onboardingPending = localGet\(ONBOARDING_STORAGE\) !== 'yes'[\s\S]*controls\.hidden = transcript\.hidden = form\.hidden = show[\s\S]*localSet\(ONBOARDING_STORAGE, 'yes'\)/,
  'the chooser replaces everything below the header until a choice is remembered');
assert.match(source,
  /chooseHosted\.onclick = \(\) => chooseOnboardingProvider\('hosted'\)[\s\S]*chooseOpenAi\.onclick = \(\) => chooseOnboardingProvider\('openai'\)[\s\S]*chooseCredits\.onclick = \(\) => chooseOnboardingProvider\('credits'\)/,
  'each onboarding choice enters its existing provider flow');
assert.match(html,
  /\.ai-onboarding \{[^}]*grid-row:2 \/ -1;[^}]*overflow:auto;[\s\S]*\.ai-onboarding-choice \{[^}]*width:100%;[^}]*flex-direction:column/,
  'the first-use chooser fills the dock below its persistent header');
assert.match(source,
  /showBalance[\s\S]*available_micros[\s\S]*updateSend = \(\) => \{\s*showBalance\(\)/,
  'the header balance follows every credits-account state refresh');
assert.match(html, /\.ai-balance \{[^}]*white-space:nowrap;[^}]*cursor:help;/,
  'the compact balance badge stays readable without expanding the header');
assert.match(source, /createAiPanel\([\s\S]*commitHistory: recordHistory[\s\S]*restoreSnapshot: restoreAiSnapshot/,
  'the dock uses the editor history boundary for per-turn undo and revert');
assert.match(source,
  /newChat\.setAttribute\('aria-label', 'New chat'\)[\s\S]*const resetConversation[\s\S]*transcript\.textContent = ''[\s\S]*clearUsage\(\);\s*showSpend\(\);[\s\S]*rebuildAgent\(\)/,
  'New chat clears the transcript and spend and rebuilds the agent conversation');
// One dock, four API boundaries: the provider chosen there decides which host
// the key, the model list, and every request belong to.
assert.match(source, /providerSelect\.onchange = \(\) => \{[\s\S]*applyProvider\(chosen, true\)/,
  'switching provider re-points the dock at that provider stored key and models');
assert.match(source, /`Data sent to: \$\{host\} only`/,
  'the disclosed data boundary names the connected provider host');
// A free provider is two hops — the project's proxy, then whichever API it
// holds a shared key for — and the line names both rather than only the host
// the browser opens a socket to. Which second hop it is comes from the
// descriptor, because there is now more than one.
assert.match(source,
  /upstream\s*\?\s*`Data sent to: \$\{host\} → \$\{upstream\.host\} `[\s\S]*provider\(\)\.accountAuth[\s\S]*'\(shared key\)'/,
  'the shared-key boundary names the proxy and where it forwards to');
assert.match(source, /new FlowgraphAgent\(\{\s*provider: providerId,/,
  'the agent talks to the provider the dock is connected to');
assert.match(source, /newChat\.disabled = onboardingPending \|\| !!controller \|\| !ready\(\)/,
  'New chat cannot interrupt an active turn or run without a connection');
// Consent, not a key, is what the first Send waits on: the free provider needs
// no connecting, but nothing leaves the browser before the dialog has said
// where it goes.
assert.match(source,
  /if \(!hasConsent\(providerId\) \|\| !ready\(\)\) \{ showConnect\(\); return; \}/,
  'the first Send gates on consent for every provider');
assert.match(source,
  /const requireConsent = \(\): boolean => \{[\s\S]*Check the consent box above to continue\.[\s\S]*consent\.focus\(\)[\s\S]*if \(!requireConsent\(\)\) return;/,
  'provider sign-in explains missing consent instead of silently doing nothing');
assert.match(source,
  /rememberLabel\.hidden = chosen\.keyless \|\| !!chosen\.accountAuth/,
  'keyless and account providers hide the irrelevant remember-key row');
assert.match(html, /\.ai-consent\[hidden\] \{ display:none; \}/,
  'the consent flex layout cannot override the remember-key row hidden state');

// ---- embedded layout (?embed=1) --------------------------------------------
// What another page frames is #workspaceContent and nothing else, with one
// button standing in for the toolbar's ▶ and the run bar's Stop at once.
assert.match(html, /id="embedControls"[^>]*class="embed-controls"[^>]*hidden/,
  'the embedded controls ship hidden and are turned on by the embed flag');
assert.match(html, /id="runPane"[\s\S]*id="embedControls"[\s\S]*<\/div>\s*<div id="consoleSplitter"/,
  'the embedded controls live inside #workspaceContent, over both panels');
assert.match(html, /<a id="embedOpen"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/,
  'opening the flowgraph in the full editor is a link, in a tab of its own');
assert.match(html, /\.embed-run \{ grid-column:2; justify-self:center; \}/,
  'Run sits in the middle of the frame');
assert.match(html, /\.embed-corner \{ grid-column:3; justify-self:end;/,
  'the way out and the zoom pair share the corner, clear of Run');
// An embed has no toolbar and no menu bar, so these are the only zoom controls a
// frame without a keyboard has.
assert.match(html, /<div id="embedZoom"[\s\S]*id="embedZoomIn"[^>]*data-tool="Zoom In"[\s\S]*id="embedZoomOut"[^>]*data-tool="Zoom Out"/,
  'the embedded corner carries zoom in and zoom out, named as the toolbar names them');
assert.match(html, /\.embed-controls \{[^}]*pointer-events:none/,
  'the row spanning the frame must not become a strip of dead canvas');
assert.match(html, /@media \(max-width:820px\)[\s\S]*\.embed-open-long \{ display:none; \}/,
  'a phone-sized frame gets the short label instead');
// display:none rather than visibility, so each dropped part's grid track collapses.
const embeddedHidden = html.match(/((?:#app\.embedded [^{,]+,\s*)*#app\.embedded [^{,]+)\{ display:none; \}/);
assert.ok(embeddedHidden, 'the embedded layout hides the application chrome with display:none');
for (const part of ['header', '#palette', '#paletteSplitter', '#paletteToggle', '#workspaceTabs',
                    '#consoleSplitter', '#consoleToggle', '#log', '#runBar'])
  assert.match(embeddedHidden[1], new RegExp(`#app\\.embedded ${part}[\\s,]`),
    `the embedded layout drops ${part}`);
assert.match(embeddedHidden[1], /#app\.embedded \.ai-splitter[\s,]/);
assert.match(embeddedHidden[1], /#app\.embedded \.ai-dock[\s,]/,
  'an embedded flowgraph does not expose the application Graham dock');
assert.match(embeddedHidden[1], /#app\.embedded \.ai-toggle[\s,]/,
  'an embedded flowgraph does not expose the Graham rail');
assert.match(html, /\.embed-controls \{[^}]*position:absolute;[^}]*z-index:40/,
  'the embedded controls float over the panels rather than taking a bar of their own');

assert.match(source, /const EMBEDDED = \(\(\) => \{[\s\S]*URLSearchParams\(location\.search\)\.get\('embed'\)/,
  'embedded mode is a query parameter, leaving the fragment to name the flowgraph');
assert.match(source, /if \(EMBEDDED\) el\('app'\)\.classList\.add\('embedded'\)/,
  'embedded mode is applied as a class the stylesheet keys the whole layout off');
assert.match(source,
  /if \(runnerRunning\) \{ stop\(\); return; \}[\s\S]*await run\(\);/,
  'the one embedded button runs the flowgraph and stops it again');
assert.match(source, /if \(!runnerRunning\) \{\s*updateEmbedRun\(\/\* failed \*\/ true\)/,
  'a refused flowgraph reports on the button, since an embed has no console pane');
assert.doesNotMatch(source, /showWelcomePopup|gnuradio_world_welcome_seen|Welcome to GNU Radio World/,
  'the removed welcome modal cannot return through startup code or local-storage state');

// ?run=1 — the link that opens on the running flowgraph rather than on the
// canvas. A query parameter like `embed`, applied last so the graph it starts is
// the one the fragment named, and never awaited inside `editorReady`, which
// bootstrap.ts reveals the page off.
assert.match(source, /const AUTO_RUN = \(\(\) => \{[\s\S]*URLSearchParams\(location\.search\)\.get\('run'\)/,
  'auto-run is a query parameter, leaving the fragment to name the flowgraph');
assert.match(source, /const AUTO_RUN = \(\(\) => \{\s*if \(TRAINING_EXAMPLE\) return false;/,
  'a training lesson is deliberately incomplete, so ?run=1 does not try to run it');
assert.match(source, /if \(AUTO_RUN\) setTimeout\(\(\) => void autoRunFromUrl\(\), 0\);/,
  'the auto-run is deferred and unawaited, so the page is revealed before it starts');
assert.match(source, /applyZoomFromUrl\(\);[\s\S]*if \(AUTO_RUN\) setTimeout/,
  'the auto-run comes after the flowgraph, ?zoom= and ?center= have been applied');
assert.match(source,
  /async function autoRunFromUrl\(\)[\s\S]*if \(EMBEDDED && requestEmbedRun\) \{ await requestEmbedRun\(\); return; \}[\s\S]*await run\(\);/,
  'an embedded auto-run goes through the embed button, which is where a refusal shows');

assert.match(source,
  /href = historyIndex > 0 \? await flowgraphToUrl\(\) : embedOpenUrl\(\)/,
  'the Open link carries the edited canvas, and the plain example link until then');
assert.match(source, /embedOpen\.href = href;[\s\S]*embedOpenBlock\.href = href;/,
  'the no_controls stand-in opens the same place #embedOpen does');
assert.match(source, /function embedOpenUrl\(\) \{ return location\.href\.split\('#'\)\[0\]\.split\('\?'\)\[0\] \+ location\.hash; \}/,
  'leaving the embed means dropping the query the host page framed it with');
assert.match(source, /querySelectorAll<HTMLButtonElement>\(`button\[data-tool="\$\{label\}"\]`\)/,
  'the clamp greys out every zoom button, the embedded pair as well as the toolbar\'s');
assert.match(source, /embedZoom\.hidden = runnerRunning && !failed/,
  'zoom acts on the canvas, so it goes away while the QT GUI pane covers it');
for (const fn of ['resetHistory', 'recordHistory', 'restoreHistory'])
  assert.match(source, new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?void refreshEmbedOpen\\(\\);`),
    `${fn}() keeps the Open link in step with the canvas`);

// click_to_load composes with embed, but leaves every other page on the normal
// eager path. The app stylesheet belongs to main's lazy chunk; the loading
// background is fetched only while the gated class is active.
assert.match(html,
  /enabled\('embed'\) && enabled\('click_to_load'\)[\s\S]*'click-to-load-pending'/,
  'click_to_load gates startup only when embedded mode is also enabled');
assert.match(html,
  /id="clickToLoad">[\s\S]*<button type="button">Load<\/button>/,
  'the gated screen includes one Load button');
assert.match(html,
  /html\.click-to-load-pending body > :not\(#clickToLoad\) \{ display:none !important; \}/,
  'nothing from the application is visible behind the loading gate');
assert.match(html,
  /#clickToLoad \{[^}]*background:url\('\/blurry_flowgraph\.png'\) center \/ cover no-repeat/,
  'the gated screen fills the frame with the blurry flowgraph background');
assert.match(html,
  /#clickToLoad button \{[^}]*position:absolute;[^}]*left:50%;[^}]*top:50%;[^}]*translate\(-50%,-50%\)/,
  'the Load button stays centered over the background');
assert.doesNotMatch(html, /<link[^>]+editor\.css/,
  'the application stylesheet is not fetched directly by the document');
assert.match(html, /<img data-src="\/gnuradio_world_logo_dark\.svg"/,
  'the hidden header logo does not cause a duplicate initial request');
assert.match(html, /<script type="module" src="\/src\/bootstrap\.ts"><\/script>/,
  'the document initially loads only the small bootstrap module');
assert.match(source, /import '\.\/editor\.css';/,
  'the editor stylesheet is fetched with the editor application');
assert.match(source,
  /if \(deferred\) \{[\s\S]*button\.addEventListener\('click',[\s\S]*await loadEditor\(\)/,
  'a gated embed waits for the Load click before importing the application');
assert.match(source, /async function loadEditor\(\)[\s\S]*await import\('\.\/main'\)/,
  'the application stays in a dynamic chunk behind the bootstrap');
assert.match(source,
  /const editor = await import\('\.\/main'\);[\s\S]*await editor\.editorReady;[\s\S]*root\.classList\.remove\('app-bootstrapping', 'click-to-load-pending'\)/,
  'the startup gate stays up until the initial flowgraph has settled');
assert.match(source,
  /export const editorReady = paletteReady\.then\(async \(\) => \{[\s\S]*historyReady = true; resetHistory\(\);/,
  'the editor exposes initial palette and flowgraph completion to its bootstrap');
assert.match(source,
  /function loadHeaderLogo\(\)[\s\S]*header \.brand img\[data-src\][\s\S]*logo\.src = logo\.dataset\.src/,
  'the application header logo is loaded when the editor starts');

console.log('checked tabbed editor/QT GUI workspace, persistent console, and embedded layout');
