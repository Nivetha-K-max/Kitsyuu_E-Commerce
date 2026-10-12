import { NextResponse } from 'next/server';
import { helpTopics, supportCategories } from '@kitsyuu/core';
import { guestHelpAllowed } from '@/lib/rate-limit';
import { currentCustomer, db } from '@/lib/server';

/* What the store's help window shows when it is opened (2026-10-12): the fixed help topics (their answers come from the
   business's own settings), the topics a message can be filed under, and whether the visitor is signed in (so the form
   does not ask a customer for a name and email the store already has), and whether the guest features are open on this
   server (`guest`: so the window does not offer a form the server would refuse). Takes no input. Never cached. Any error answers
   with nothing to show; the window then says help is not available. */
export const dynamic = 'force-dynamic';

export async function GET() {
  let body: { signedIn: boolean; guest: boolean; topics: { id: string; question: string; answer: string }[]; categories: { code: string; label: string }[] } = { signedIn: false, guest: false, topics: [], categories: [] };
  try {
    const [me, topics, categories] = await Promise.all([currentCustomer(), helpTopics(db()), supportCategories(db())]);
    body = { signedIn: !!me, guest: guestHelpAllowed(), topics: topics.map(t => ({ id: t.id, question: t.question, answer: t.answer })), categories };
  } catch (e) {
    console.error('[api/help]', (e as Error).message);
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
