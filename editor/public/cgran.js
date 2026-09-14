(() => {
  const input = document.querySelector('[data-cgran-search]');
  const cards = [...document.querySelectorAll('[data-cgran-card]')];
  const status = document.querySelector('[data-cgran-status]');
  if (!input || !status) return;
  const update = () => {
    const query = input.value.trim().toLocaleLowerCase();
    let shown = 0;
    for (const card of cards) {
      card.hidden = Boolean(query) && !card.dataset.search.includes(query);
      if (!card.hidden) shown++;
    }
    status.textContent = query ? `${shown} project${shown === 1 ? '' : 's'} found` : '';
  };
  input.addEventListener('input', update);
})();
