export interface Env {
  DB: D1Database;
  EMAIL?: SendEmail;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  POLAR_ACCESS_TOKEN: string;
  POLAR_WEBHOOK_SECRET: string;
  OPENAI_API_KEY: string;
  ENVIRONMENT?: 'development' | 'sandbox' | 'production';
  APP_URL?: string;
  TRUSTED_ORIGINS?: string;
  POLAR_SERVER?: 'sandbox' | 'production';
  CREDIT_PRODUCTS?: string;
  MAX_CHAT_BODY_BYTES?: string;
  MAX_COMPLETION_TOKENS?: string;
  HOLD_TTL_SECONDS?: string;
  PURCHASE_RATE_LIMIT_PER_HOUR?: string;
  ALERT_WEBHOOK_URL?: string;
  EMAIL_WEBHOOK_URL?: string;
  PROVIDER_SPEND_URL?: string;
  PROVIDER_SPEND_TOKEN?: string;
  ABSORBED_ALERT_BPS?: string;
  EMAIL_FROM?: string;
  SUPPORT_EMAIL?: string;
  LOCAL_INSECURE_COOKIES?: string;
}

export interface ProductConfig {
  productId: string;
  creditsMicros: number;
}

export interface RuntimeConfig {
  appUrl: string;
  trustedOrigins: string[];
  polarServer: 'sandbox' | 'production';
  products: Record<string, ProductConfig>;
  productCredits: Map<string, number>;
  maxChatBodyBytes: number;
  maxCompletionTokens: number;
  holdTtlSeconds: number;
  purchaseRateLimitPerHour: number;
  absorbedAlertBps: number;
}

const positiveInteger = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

const parseProducts = (raw: string | undefined): Record<string, ProductConfig> => {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CREDIT_PRODUCTS must be a JSON object keyed by checkout slug');
  }
  const products: Record<string, ProductConfig> = {};
  for (const [slug, value] of Object.entries(parsed)) {
    const product = value as Partial<ProductConfig>;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || typeof product.productId !== 'string' ||
        !product.productId || !Number.isSafeInteger(product.creditsMicros) ||
        Number(product.creditsMicros) <= 0) {
      throw new Error(`Invalid credit product configuration for ${slug}`);
    }
    products[slug] = {
      productId: product.productId,
      creditsMicros: Number(product.creditsMicros),
    };
  }
  return products;
};

export function runtimeConfig(env: Env): RuntimeConfig {
  const products = parseProducts(env.CREDIT_PRODUCTS);
  return {
    appUrl: (env.APP_URL || 'https://gnuradioworld.com').replace(/\/$/, ''),
    trustedOrigins: (env.TRUSTED_ORIGINS ||
      'https://gnuradioworld.com,https://www.gnuradioworld.com,https://gnuradio-wasm.pages.dev,https://*.gnuradio-world-previews.pages.dev')
      .split(',').map(value => value.trim()).filter(Boolean),
    polarServer: env.POLAR_SERVER === 'production' ? 'production' : 'sandbox',
    products,
    productCredits: new Map(Object.values(products).map(product =>
      [product.productId, product.creditsMicros])),
    maxChatBodyBytes: positiveInteger(env.MAX_CHAT_BODY_BYTES, 200_000),
    maxCompletionTokens: positiveInteger(env.MAX_COMPLETION_TOKENS, 16_384),
    holdTtlSeconds: positiveInteger(env.HOLD_TTL_SECONDS, 900),
    purchaseRateLimitPerHour: positiveInteger(env.PURCHASE_RATE_LIMIT_PER_HOUR, 10),
    absorbedAlertBps: positiveInteger(env.ABSORBED_ALERT_BPS, 200),
  };
}

export function assertSecrets(env: Env): void {
  const required: Array<keyof Env> = [
    'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
    'POLAR_ACCESS_TOKEN', 'POLAR_WEBHOOK_SECRET', 'OPENAI_API_KEY',
  ];
  const missing = required.filter(name => !env[name]);
  if (missing.length) throw new Error(`Missing server configuration: ${missing.join(', ')}`);
}
