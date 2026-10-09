/* Account data shared by the account layout (profile header) and its pages: read once per request. */
import { cache } from 'react';
import { getCustomerProfile } from '@kitsyuu/core';
import type { CustomerPrincipal } from '@kitsyuu/auth';
import { db } from './server';

export const accountProfile = cache((me: CustomerPrincipal) => getCustomerProfile(db(), me));
