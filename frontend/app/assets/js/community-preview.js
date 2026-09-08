// Preview is a maintenance surface. A query string alone is not authorization.
let decision;
export function allowCommunityPreview() {
  if (decision) return decision;
  decision = (async () => {
    if (new URLSearchParams(location.search).get('preview') === '1') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch('/admin/api/me', {
          credentials: 'include', cache: 'no-store', signal: controller.signal,
        });
        if (response.ok && (response.headers.get('content-type') || '').includes('application/json')) {
          const body = await response.json();
          if ((body?.data || body)?.id) {
            document.documentElement.dataset.homerCommunityPreview = 'allowed';
            return true;
          }
        }
      } catch { /* Fail closed when the administrative session cannot be verified. */ }
      finally { clearTimeout(timeout); }
    }
    location.replace('/app/explore.html');
    return false;
  })();
  return decision;
}
