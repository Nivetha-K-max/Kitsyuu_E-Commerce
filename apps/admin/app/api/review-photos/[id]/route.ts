import { can } from '@kitsyuu/auth';
import { reviewPhoto } from '@kitsyuu/core';
import { currentActor, db } from '@/lib/server';

/* M12: a customer review photo for staff with reviews.read, in any moderation state (the store serves approved ones only).
   Never cached publicly: an unapproved photo must not end up in a shared cache. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  if (!actor || !can(actor, 'reviews.read')) return new Response('Not found', { status: 404 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const photo = await reviewPhoto(db(), id, actor);
  if (!photo) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(photo.bytes), { headers: { 'Content-Type': photo.content_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
