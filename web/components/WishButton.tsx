'use client';
import { useHydrated, useStore } from './StoreProvider';
import { Icons } from './icons';

/* Every heart (cards and product page) toggles the same wishlist entry. */
export default function WishButton({ id, label, variant }: { id: string; label: string; variant: 'card' | 'pdp' }) {
  const { wishIds, toggleWish, toast, idx } = useStore();
  const on = useHydrated() && wishIds.includes(id);
  const click = () => {
    const p = idx.byId.get(id); if (!p) return;
    const now = toggleWish(id);
    toast(now ? `Saved ${p.name} to your wishlist.` : `Removed ${p.name} from your wishlist.`);
  };
  if (variant === 'card') {
    return <button className="st-wish" type="button" data-wish={id} aria-pressed={on} aria-label={label} onClick={click}>{Icons.heart}</button>;
  }
  return (
    <button className="st-wish-btn" type="button" data-wish={id} aria-pressed={on} onClick={click}>
      {Icons.heart}<span data-wish-label>{on ? 'Saved to wishlist' : 'Add to wishlist'}</span>
    </button>
  );
}
