// The editor's deliberately tiny loading boundary. Keep imports out of this
// file: a click-to-load embed must not pull any application code or CSS into
// the bootstrap chunk before its reader asks for it.

const root = document.documentElement;
const gate = document.getElementById('clickToLoad')!;
const button = gate.querySelector('button') as HTMLButtonElement;
const deferred = root.classList.contains('click-to-load-pending');

function loadHeaderLogo() {
  const logo = document.querySelector<HTMLImageElement>('header .brand img[data-src]');
  if (!logo) return;
  logo.src = logo.dataset.src!;
  logo.removeAttribute('data-src');
}

async function loadEditor() {
  const editor = await import('./main');
  // main.ts can render palette rows before the URL/default flowgraph has
  // finished loading. Keep the application gated until that initial canvas is
  // settled, or an early click can be overwritten by the late startup load.
  await editor.editorReady;
  loadHeaderLogo();
  root.classList.remove('app-bootstrapping', 'click-to-load-pending');
  gate.remove();
}

if (deferred) {
  button.focus();
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Loading…';
    try {
      await loadEditor();
    } catch (error) {
      console.error('Could not load GNU Radio World:', error);
      button.disabled = false;
      button.textContent = 'Retry';
    }
  });
} else {
  void loadEditor().catch(error => {
    root.classList.remove('app-bootstrapping');
    console.error('Could not load GNU Radio World:', error);
  });
}
