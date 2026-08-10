'use client';

import { createClient } from '@nhost/nhost-js';

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN;
const region = process.env.NEXT_PUBLIC_NHOST_REGION;

if (!subdomain || !region) {
  throw new Error(
    'NEXT_PUBLIC_NHOST_SUBDOMAIN and NEXT_PUBLIC_NHOST_REGION must be set',
  );
}

/**
 * Browser-side nhost client. Handles the session in localStorage and refreshes
 * the access token; both the Apollo HTTP link and the websocket link ask it for
 * a fresh token before every request rather than caching one.
 */
export const nhost = createClient({ subdomain, region });

export const graphqlUrl = `https://${subdomain}.hasura.${region}.nhost.run/v1/graphql`;
export const graphqlWsUrl = `wss://${subdomain}.hasura.${region}.nhost.run/v1/graphql`;
