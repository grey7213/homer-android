import { api, isLoggedIn, ApiError } from '/app/assets/js/app-core.js?v=20260918-r9';

const statusNode = document.querySelector('[data-home-status]');
const go = path => location.replace(path);

async function openHome() {
  if (!isLoggedIn()) {
    go('/app/login.html?next=%2Fapp%2F');
    return;
  }
  try {
    // rawRequest 返回完整信封；本机验收模式直接返回 data，两种形态都要支持。
    const bootstrap = await api.social('bootstrap');
    const access = bootstrap?.data ?? bootstrap;
    if (access?.available) {
      go('/app/community.html');
      return;
    }
    if (statusNode) statusNode.textContent = '社区维护中，正在前往探索…';
  } catch (error) {
    if (error instanceof ApiError && error.code === 401) {
      go('/app/login.html?next=%2Fapp%2F');
      return;
    }
    if (statusNode) statusNode.textContent = '社区暂不可用，正在前往探索…';
  }
  go('/app/explore.html');
}

openHome();
