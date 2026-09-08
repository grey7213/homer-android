// App-owned confirmations. Callers await the decision; no synchronous browser UI.
let pendingDialog = null;
function ensureStyle() {
  if (document.querySelector('#homer-action-dialog-style')) return;
  const style = document.createElement('link');
  style.id = 'homer-action-dialog-style'; style.rel = 'stylesheet';
  style.href = new URL('../css/dialogs.css?v=20260908-pr7', import.meta.url).href;
  document.head.append(style);
}
function node(tag, className, text) {
  const el = document.createElement(tag); el.className = className;
  if (text != null) el.textContent = String(text);
  return el;
}
function ask(message, { title = '确认操作', confirmText = '确认', cancelText = '取消', noticeOnly = false } = {}) {
  // Repeated taps must not stack dialogs or authorize the same operation twice.
  if (pendingDialog) return Promise.resolve(false);
  ensureStyle();
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = node('dialog', 'homer-action-dialog');
    dialog.setAttribute('aria-labelledby', 'homer-action-title');
    dialog.setAttribute('aria-describedby', 'homer-action-copy');
    const heading = node('h2', '', title); heading.id = 'homer-action-title';
    const copy = node('p', '', message); copy.id = 'homer-action-copy';
    const footer = node('footer', '');
    const cancel = node('button', 'homer-action-cancel', cancelText); cancel.type = 'button';
    const confirm = node('button', 'homer-action-confirm', noticeOnly ? '知道了' : confirmText); confirm.type = 'button';
    let accepted = false;
    if (!noticeOnly) footer.append(cancel);
    footer.append(confirm); dialog.append(heading, copy, footer); document.body.append(dialog);
    pendingDialog = dialog;
    cancel.addEventListener('click', () => dialog.close());
    confirm.addEventListener('click', () => { accepted = true; dialog.close(); });
    dialog.addEventListener('close', () => {
      pendingDialog = null; dialog.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      resolve(accepted);
    }, { once: true });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    dialog.showModal();
    (noticeOnly ? confirm : cancel).focus({ preventScroll: true });
  });
}
export function confirmAction(message, options) { return ask(message, options); }
export function showMessage(message) { return ask(message, { title: '操作未完成', noticeOnly: true }); }
