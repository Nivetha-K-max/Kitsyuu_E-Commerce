/* Dark / light theme (2026-10-01): shared by the root layout (server) and components/ThemeToggle.tsx (client).
   The store's default theme comes from STORE_THEME (dark unless set to "light"). A visitor's choice is kept in this
   browser only (localStorage) and applied before the first paint by THEME_BOOT, so the page never flashes the other
   theme. Colours: public/store.css → "Themes". */
export type Theme = 'dark' | 'light';
export const THEME_KEY = 'kitsyuu-theme';
export const DEFAULT_THEME: Theme = process.env.STORE_THEME === 'light' ? 'light' : 'dark';
/** Inline in <head>: applies a saved choice before the page paints (plain ES5, never throws). */
export const THEME_BOOT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
export const THEME_COLOUR: Record<Theme, string> = { dark: '#101011', light: '#f4f1eb' };
