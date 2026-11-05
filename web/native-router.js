(() => {
  if (!window.omnia) return;
  const launcher = document.querySelector('.launcher'),
    footer = document.querySelector('.launcher-footer');
  const back = document.createElement('button');
  back.className = 'back-tool shell-back';
  back.hidden = true;
  back.textContent = '←  HUB';
  back.setAttribute('aria-label', 'Back to Hub');
  document.querySelector('.titlebar').prepend(back);
  const notice = document.createElement('div');
  notice.className = 'shell-notice';
  notice.hidden = true;
  notice.setAttribute('role', 'status');
  document.body.append(notice);
  let timer;
  function message(text) {
    clearTimeout(timer);
    notice.textContent = text;
    notice.hidden = false;
    timer = setTimeout(() => (notice.hidden = true), 5000);
  }
  function navigate(id) {
    document.body.dataset.activeTool = id;
    launcher.style.visibility = footer.style.visibility = id === 'home' ? 'visible' : 'hidden';
    back.hidden = id === 'home';
    document.querySelector('.titlebar .wordmark').hidden = id !== 'home';
  }
  const open = (id) => window.omnia.openTool(id).catch((error) => message(error.message));
  window.omniaRouter = {
    open,
    message,
    discard: (id) => window.omnia.toolView('discard', { id }),
    quarantine: (id) => window.omnia.toolHealth('fault', { id }),
  };
  window.omnia.onNavigate(navigate);
  window.omnia.onNotice(message);
  window.omnia.onToolTransition((state) => {
    document.body.dataset.transitioning = String(state.moving);
    if (state.moving && state.tool === 'home')
      launcher.style.visibility = footer.style.visibility = 'visible';
    back.disabled = state.moving;
    document.querySelector('#settings').disabled = state.moving;
  });
  back.addEventListener('click', () => open('home'));
  navigate('home');
  document.body.dataset.transitioning = 'false';
})();
