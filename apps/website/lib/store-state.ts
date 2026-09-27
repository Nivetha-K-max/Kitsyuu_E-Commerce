import 'server-only';
/* The signed-in customer's store state (cart + wishlist) as the browser receives it. */
import { getCustomerCart, getWishlist, lineProblemText } from '@kitsyuu/core';
import type { CustomerPrincipal } from '@kitsyuu/auth';
import type { CustomerStore } from './types';
import { clientCart, commerceConfig } from './commerce';
import { db } from './server';

export async function customerStore(me: CustomerPrincipal): Promise<CustomerStore> {
  const [cart, wishlist] = await Promise.all([getCustomerCart(db(), me, commerceConfig()), getWishlist(db(), me)]);
  return { cart: clientCart(cart, lineProblemText), wishlist };
}
