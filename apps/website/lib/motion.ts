/* Reduced motion for the storefront's scroll animations (2026-10-01): the system setting, or the store's own switch
   (localStorage 'kietsu-reduce-motion', set on /our-story; StoreProvider mirrors it as <html class="st-reduce">). The
   switch is read directly as well as through the class, because child effects (the homepage film and choreography) run
   before StoreProvider's effect adds the class on the first page load. */
export function reducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('st-reduce')) return true;
  try { return localStorage.getItem('kietsu-reduce-motion') === 'true'; } catch { return false; }
}
