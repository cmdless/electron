import { useEffect, useState } from 'react';

// each picker's node side opens `dist/index.html#/some-route` (see
// node/ui.ts's pickerSource) - this just reads that hash back out and
// re-reads it on change, no routing library needed for a single flat list
// of top-level views.
function getRoute() {
  return window.location.hash.replace(/^#/, '') || '/';
}

export function useHashRoute() {
  const [route, setRoute] = useState(getRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(getRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}
