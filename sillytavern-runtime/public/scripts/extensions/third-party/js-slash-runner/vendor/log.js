(function () {
  const iframeName = getIframeName();

  _th_impl._init(iframeName);

  function override(level) {
    const original = console[level];
    console[level] = (...args) => {
      _th_impl._log(iframeName, level, ...args);
      original(...args);
    };
  }

  override('log');
  override('debug');
  override('info');
  override('warn');
  override('error');

  $(window).on('pagehide', () => {
    _th_impl._clearLog(iframeName);
  });
})();

