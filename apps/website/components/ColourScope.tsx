'use client';
import { createContext, useContext, useState } from 'react';

/* Third pass: the colour chosen on a product page, shared by the size picker (BuyForm) and the photos (Gallery).
   null = a product without colours. */
const Ctx = createContext<{ colour: string | null; setColour: (c: string | null) => void }>({ colour: null, setColour: () => {} });

export function ColourScope({ initial, children }: { initial: string | null; children: React.ReactNode }) {
  const [colour, setColour] = useState(initial);
  return <Ctx.Provider value={{ colour, setColour }}>{children}</Ctx.Provider>;
}

export const useColour = () => useContext(Ctx);
