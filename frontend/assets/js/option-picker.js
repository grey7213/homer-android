/* Designed option windows, retaining the original control's binding and value. */
(() => {
  if (window.HomerOptionPicker) return;
  const source = document.currentScript?.src || new URL('/assets/js/option-picker.js', location.href).href;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = new URL('../css/option-picker.css?v=20260908-pr7', source).href;
  document.head.append(css);
  let active = null;
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function labelFor(select) {
    return select.getAttribute('aria-label') || select.getAttribute('data-picker-title')
      || Array.from(select.labels || []).map(label => {
        const copy = label.cloneNode(true);
        copy.querySelectorAll('select,script,template,button').forEach(node => node.remove());
        return copy.textContent.trim();
      }).filter(Boolean).join(' ') || select.title || '选择选项';
  }
  function open(select) {
    if (!select?.isConnected || select.matches(':disabled') || active) return;
    const dialog = el('dialog', 'homer-option-picker');
    dialog.setAttribute('aria-labelledby', 'homer-option-picker-title');
    const head = el('header', 'homer-option-picker__head');
    const title = el('h2', '', labelFor(select));
    title.id = 'homer-option-picker-title';
    const close = el('button', 'homer-option-picker__close', '×');
    close.type = 'button'; close.setAttribute('aria-label', '关闭选项');
    head.append(title, close);
    const search = el('input', 'homer-option-picker__search');
    search.type = 'search'; search.placeholder = '搜索选项';
    search.setAttribute('aria-label', '搜索选项');
    const list = el('div', 'homer-option-picker__list');
    list.setAttribute('role', 'group'); list.setAttribute('aria-label', '可选项');
    const status = el('p', 'homer-option-picker__status');
    status.setAttribute('role', 'status');
    const footer = el('footer', 'homer-option-picker__footer');
    const cancel = el('button', '', '取消'); cancel.type = 'button';
    footer.append(cancel);
    const pending = new Set(Array.from(select.selectedOptions));
    function commit() {
      if (!select.isConnected || select.matches(':disabled')) { dialog.close(); return; }
      Array.from(select.options).forEach(option => { option.selected = pending.has(option); });
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      dialog.close();
    }
    if (select.multiple) {
      const apply = el('button', 'is-primary', '确认选择'); apply.type = 'button';
      apply.addEventListener('click', commit); footer.append(apply);
    }
    function render() {
      list.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase();
      let count = 0; let lastGroup = null;
      Array.from(select.options).forEach(option => {
        if (option.hidden || !option.text.toLocaleLowerCase().includes(query)) return;
        const group = option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement : null;
        if (group && group !== lastGroup) list.append(el('h3', 'homer-option-picker__group', group.label));
        lastGroup = group;
        const button = el('button', 'homer-option-picker__option'); button.type = 'button';
        button.disabled = option.disabled || !!group?.disabled;
        button.setAttribute('role', select.multiple ? 'checkbox' : 'radio');
        button.setAttribute('aria-checked', String(pending.has(option)));
        button.append(el('span', '', option.text), el('span', 'homer-option-picker__check', pending.has(option) ? '✓' : ''));
        button.lastElementChild.setAttribute('aria-hidden', 'true');
        button.addEventListener('click', () => {
          if (select.multiple) {
            pending.has(option) ? pending.delete(option) : pending.add(option);
            button.setAttribute('aria-checked', String(pending.has(option)));
            button.lastElementChild.textContent = pending.has(option) ? '✓' : '';
          } else { pending.clear(); pending.add(option); commit(); }
        });
        list.append(button); count++;
      });
      status.textContent = count ? `${count} 个选项` : (select.options.length ? '没有匹配的选项，试试其他关键词' : '暂无可选项');
    }
    dialog.append(head, search, list, status, footer);
    document.body.append(dialog); active = { dialog, select };
    const observer = new MutationObserver(render);
    observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
    close.addEventListener('click', () => dialog.close());
    cancel.addEventListener('click', () => dialog.close());
    search.addEventListener('input', render);
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      observer.disconnect(); active = null; dialog.remove();
      if (select.isConnected) select.focus({ preventScroll: true });
    }, { once: true });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); dialog.close(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      if (event.target === search && event.key !== 'ArrowDown') return;
      const choices = [...list.querySelectorAll('button:not(:disabled)')];
      if (!choices.length) return;
      event.preventDefault();
      let index = choices.indexOf(document.activeElement);
      index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + choices.length) % choices.length;
      choices[index].focus();
    });
    render(); dialog.showModal();
    // Focus the current item without summoning the Android keyboard on every open.
    (list.querySelector('[aria-checked="true"]:not(:disabled)') || close).focus({ preventScroll: true });
    return dialog;
  }
  function selectTarget(event) {
    const node = event.target.closest?.('select:not([data-native-picker])');
    return node && !node.matches(':disabled') ? node : null;
  }
  document.addEventListener('pointerdown', event => {
    const select = selectTarget(event);
    if (!select || event.button > 0) return;
    // Do not put a modal under a finger that is still down: the following
    // click would land on its backdrop and immediately dismiss it.
    event.preventDefault();
  }, true);
  document.addEventListener('click', event => {
    const select = selectTarget(event);
    if (!select) return;
    event.preventDefault(); open(select);
  }, true);
  document.addEventListener('keydown', event => {
    const select = selectTarget(event);
    if (!select || !['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); open(select);
  }, true);
  window.HomerOptionPicker = { open, close: () => active?.dialog.close() };
  // Legacy creator panels are not native <dialog> elements. Give their actual
  // close controls the same Escape/Android Back behavior as designed pickers.
  function topOverlay() {
    const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const dialogs = [...document.querySelectorAll('dialog[open]')].filter(visible);
    if (dialogs.length) return document.activeElement?.closest('dialog[open]') || dialogs.at(-1);
    const panels = [...document.querySelectorAll('[role="dialog"][aria-modal="true"],.xy-modal')].filter(visible);
    return panels.at(-1) || null;
  }
  window.HomerCloseOverlay = () => {
    const overlay = topOverlay();
    if (!overlay) {
      const selection = document.querySelector('[data-homer-cancel-selection]');
      if (selection?.getClientRects().length) { selection.click(); return true; }
      return false;
    }
    if (overlay instanceof HTMLDialogElement) {
      // Match Escape's cancel event, so a form can retain an in-flight write.
      if (overlay.dispatchEvent(new Event('cancel', { cancelable: true }))) overlay.close('');
      return true;
    }
    const close = overlay.querySelector('[aria-label="关闭"],.cm-close,.farm-modal-close,.ws-create-close,.character-dialog-close,.xy-modal__head > button');
    if (!close) return false;
    close.click(); return true;
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && window.HomerCloseOverlay()) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
    if (event.key !== 'Tab') return;
    const overlay = topOverlay();
    if (!overlay || overlay instanceof HTMLDialogElement) return;
    const controls = [...overlay.querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"]')]
      .filter(node => !node.disabled && node.getClientRects().length);
    if (!controls.length) return;
    const first=controls[0],last=controls.at(-1);
    if (!overlay.contains(document.activeElement) || (event.shiftKey && document.activeElement===first)) {
      event.preventDefault(); (event.shiftKey?last:first).focus();
    } else if (!event.shiftKey && document.activeElement===last) { event.preventDefault(); first.focus(); }
  }, true);
})();
