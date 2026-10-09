/* Inline SVG icons, identical to the static store. */
export const Icons = {
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>,
  heart: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z" /></svg>,
  bag: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 8h14l-1 12H6L5 8Z" /><path d="M9 8V6.5a3 3 0 0 1 6 0V8" /></svg>,
  user: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8" /><path d="M4.8 20c.9-3.6 3.7-5.6 7.2-5.6s6.3 2 7.2 5.6" /></svg>,
  menu: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 9h16M4 15h16" /></svg>
};

/* Account navigation icons: same stroke and weight as the store icons above. */
const A = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
export const AccountIcons = {
  overview: <svg {...A}><rect x="4" y="4" width="7" height="7" /><rect x="13" y="4" width="7" height="7" /><rect x="4" y="13" width="7" height="7" /><rect x="13" y="13" width="7" height="7" /></svg>,
  profile: Icons.user,
  addresses: <svg {...A}><path d="M12 21s-6.5-5.6-6.5-10.6a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z" /><circle cx="12" cy="10.3" r="2.4" /></svg>,
  orders: <svg {...A}><path d="M4 8.2 12 4l8 4.2v7.6L12 20l-8-4.2V8.2Z" /><path d="m4 8.2 8 4.2 8-4.2M12 12.4V20" /></svg>,
  wishlist: Icons.heart,
  reviews: <svg {...A}><path d="m12 4.2 2.4 5 5.4.7-4 3.8 1 5.4-4.8-2.6-4.8 2.6 1-5.4-4-3.8 5.4-.7 2.4-5Z" /></svg>,
  returns: <svg {...A}><path d="M8.5 5 4.5 9l4 4" /><path d="M4.5 9h9.2a5.3 5.3 0 0 1 0 10.6H9" /></svg>,
  points: <svg {...A}><path d="M4.5 10h15v10h-15V10Z" /><path d="M3.5 6.6h17V10h-17V6.6ZM12 6.6V20" /><path d="M12 6.6C10.6 4 7.6 3.6 7.6 5.3c0 1.3 2.6 1.3 4.4 1.3Zm0 0C13.4 4 16.4 3.6 16.4 5.3c0 1.3-2.6 1.3-4.4 1.3Z" /></svg>,
  support: <svg {...A}><path d="M4.5 5.5h15v10.2h-8L7.3 19v-3.3H4.5V5.5Z" /><path d="M8.5 9.3h7M8.5 12h4.5" /></svg>,
  security: <svg {...A}><rect x="5.5" y="10.5" width="13" height="9.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></svg>,
  device: <svg {...A}><rect x="3.5" y="5" width="17" height="11.5" /><path d="M9 20h6M12 16.5V20" /></svg>,
};
