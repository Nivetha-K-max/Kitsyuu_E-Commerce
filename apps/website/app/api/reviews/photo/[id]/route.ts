import { reviewPhoto } from '@kitsyuu/core';
import { db } from '@/lib/server';

/* M12: a customer photo of an APPROVED review. Photos of reviews that are waiting or rejected answer 404, exactly like a
   photo that does not exist. Approved photos may be cached briefly; a review taken down disappears within that time. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  try {
    const photo = await reviewPhoto(db(), id);
    if (!photo) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(photo.bytes), { headers: { 'Content-Type': photo.content_type, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
