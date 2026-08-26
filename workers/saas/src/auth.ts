import { checkout, polar, portal, webhooks } from '@polar-sh/better-auth';
import { Polar } from '@polar-sh/sdk';
import { betterAuth } from 'better-auth';
import type { Env } from './env';
import { runtimeConfig } from './env';

/**
 * Build auth inside the request cycle. The D1 binding is request-scoped in a
 * Worker; exporting a module singleton here causes intermittent D1 hangs.
 */
export function createAuth(env: Env) {
  const cfg = runtimeConfig(env);
  const polarClient = new Polar({
    accessToken: env.POLAR_ACCESS_TOKEN,
    server: cfg.polarServer,
  });

  return betterAuth({
    database: env.DB,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: cfg.trustedOrigins,
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        // Better Auth includes these by default; spelling them out makes the
        // hidden-email requirement visible in the deployed configuration.
        scopes: ['read:user', 'user:email'],
      },
    },
    user: {
      validateUserInfo: ({ user, source }) => {
        if (source.oauth?.providerId === 'github' && !user.email) {
          return {
            error: 'github_email_required',
            errorDescription: 'GitHub did not provide a verified email address. Make one visible or verify one, then try again.',
          };
        }
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        trustedProviders: ['google', 'github'],
        allowDifferentEmails: false,
      },
    },
    advanced: {
      // Cloudflare overwrites this single-value header at the edge, so it is
      // safe to use for OAuth rate limiting and session IP metadata.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      useSecureCookies: env.LOCAL_INSECURE_COOKIES !== 'true',
      defaultCookieAttributes: {
        httpOnly: true,
        secure: env.LOCAL_INSECURE_COOKIES !== 'true',
        sameSite: 'lax',
        path: '/',
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/social': { window: 60, max: 10 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async user => {
            // The Polar plugin's before hook has already created or found the
            // customer. This hook creates the application wallet idempotently
            // and persists that customer id without creating one by hand.
            const { result } = await polarClient.customers.list({ email: user.email });
            const customer = result.items[0];
            await env.DB.prepare(
              `INSERT INTO wallets
                 (user_id, polar_customer_id, balance_micros, held_micros, frozen, created_at, updated_at)
               VALUES (?, ?, 0, 0, 0, unixepoch(), unixepoch())
               ON CONFLICT(user_id) DO UPDATE SET
                 polar_customer_id = COALESCE(wallets.polar_customer_id, excluded.polar_customer_id),
                 updated_at = unixepoch()`,
            ).bind(user.id, customer?.id || null).run();
          },
        },
      },
    },
    plugins: [
      polar({
        client: polarClient,
        createCustomerOnSignUp: true,
        use: [
          checkout({
            products: Object.entries(cfg.products).map(([slug, product]) => ({
              slug,
              productId: product.productId,
            })),
            successUrl: `${cfg.appUrl}/?credits=success&checkout_id={CHECKOUT_ID}`,
            returnUrl: cfg.appUrl,
            authenticatedUsersOnly: true,
          }),
          portal({ returnUrl: cfg.appUrl }),
          // Mounted as required, with the SDK performing raw-body signature
          // verification. Financial side effects live at /api/webhooks/polar,
          // where the Standard Webhooks event id is available for idempotency.
          webhooks({
            secret: env.POLAR_WEBHOOK_SECRET,
            onCustomerCreated: async payload => {
              if (!payload.data.externalId) return;
              await env.DB.prepare(
                'UPDATE wallets SET polar_customer_id = ?, updated_at = unixepoch() WHERE user_id = ?',
              ).bind(payload.data.id, payload.data.externalId).run();
            },
            onCustomerUpdated: async payload => {
              if (!payload.data.externalId) return;
              await env.DB.prepare(
                'UPDATE wallets SET polar_customer_id = ?, updated_at = unixepoch() WHERE user_id = ?',
              ).bind(payload.data.id, payload.data.externalId).run();
            },
          }),
        ],
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
