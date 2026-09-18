if(new URLSearchParams(location.search).get('tab')==='community'){
  await import('./community-screen.js?v=20260917-r8');
}else{
  await import('./hub-pages.js?v=20260917-r8');
  const script=document.createElement('script');script.src='/app/assets/vendor/alpine-3.14.1.min.js?v=3.14.1';document.head.append(script);
}
