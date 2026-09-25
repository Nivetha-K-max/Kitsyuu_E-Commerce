'use client';
import { useEffect } from 'react';
import { initTurntable } from '@/lib/turntable';

/* Renders nothing. Starts the dormant turntable player; with data-turntable="" it makes no requests. */
export default function HeroTurntable() {
  useEffect(() => initTurntable(), []);
  return null;
}
