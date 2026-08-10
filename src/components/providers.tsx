'use client';

import {
  ApolloClient,
  ApolloLink,
  HttpLink,
  InMemoryCache,
  split,
} from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import { SetContextLink } from '@apollo/client/link/context';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient as createWsClient } from 'graphql-ws';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { graphqlUrl, graphqlWsUrl, nhost } from '@/lib/nhost-client';
import type { StoredSession } from '@nhost/nhost-js/session';

// ---------------------------------------------------------------------------
// Auth context
// ---------------------------------------------------------------------------

interface AuthState {
  session: StoredSession | null;
  loading: boolean;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  session: null,
  loading: true,
  userId: null,
  email: null,
  displayName: null,
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

/**
 * Returns a valid access token, refreshing if it is within 60s of expiry.
 *
 * Both links call this per operation. A subscription that outlives its token
 * would otherwise be silently dropped by Hasura mid-run — which is exactly when
 * the live step feed matters most.
 */
async function freshToken(): Promise<string | null> {
  try {
    const session = await nhost.refreshSession(60);
    return session?.accessToken ?? null;
  } catch {
    return nhost.getUserSession()?.accessToken ?? null;
  }
}

function makeApolloClient() {
  const authLink = new SetContextLink(async (prevContext) => {
    const token = await freshToken();
    return {
      ...prevContext,
      headers: {
        ...prevContext.headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
  });

  const httpLink = new HttpLink({ uri: graphqlUrl });

  const wsLink = new GraphQLWsLink(
    createWsClient({
      url: graphqlWsUrl,
      lazy: true,
      retryAttempts: 12,
      // Evaluated on every (re)connect, so a reconnect after a token refresh
      // authenticates with the new token rather than a stale one.
      connectionParams: async () => {
        const token = await freshToken();
        return token ? { headers: { authorization: `Bearer ${token}` } } : {};
      },
    }),
  );

  const link = split(
    ({ query }) => {
      const def = getMainDefinition(query);
      return def.kind === 'OperationDefinition' && def.operation === 'subscription';
    },
    wsLink,
    ApolloLink.from([authLink, httpLink]),
  );

  return new ApolloClient({
    link,
    cache: new InMemoryCache({
      typePolicies: {
        // Hasura returns these keyed by id; without this Apollo cannot normalise
        // subscription payloads onto the same objects the queries fetched.
        workflow_runs: { keyFields: ['id'] },
        step_runs: { keyFields: ['id'] },
        workflows: { keyFields: ['id'] },
        workflow_steps: { keyFields: ['id'] },
        workflow_triggers: { keyFields: ['id'] },
        organizations: { keyFields: ['id'] },
        org_usage_current_month: { keyFields: ['org_id'] },
      },
    }),
    defaultOptions: {
      watchQuery: { fetchPolicy: 'cache-and-network' },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [loading, setLoading] = useState(true);

  const client = useMemo(makeApolloClient, []);

  useEffect(() => {
    setSession(nhost.getUserSession());
    setLoading(false);
    const unsubscribe = nhost.sessionStorage.onChange((s) => setSession(s));
    return () => unsubscribe();
  }, []);

  const value: AuthState = useMemo(
    () => ({
      session,
      loading,
      userId: session?.user?.id ?? null,
      email: session?.user?.email ?? null,
      displayName: session?.user?.displayName ?? null,
      signOut: async () => {
        const refreshToken = nhost.getUserSession()?.refreshToken;
        try {
          if (refreshToken) await nhost.auth.signOut({ refreshToken });
        } finally {
          // Drop every cached row on sign-out. Without this, switching to a
          // different org's user in the same tab could paint the previous
          // user's data for a frame before the refetch lands.
          await client.clearStore();
          setSession(null);
        }
      },
    }),
    [session, loading, client],
  );

  return (
    <ApolloProvider client={client}>
      <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    </ApolloProvider>
  );
}
