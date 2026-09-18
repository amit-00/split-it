import { betterAuth } from "better-auth";

export interface AppEnv extends Env {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

export function isAuthConfigured(env: AppEnv): boolean {
  return Boolean(env.BETTER_AUTH_URL && env.BETTER_AUTH_SECRET?.length >= 32 && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function createAuth(env: AppEnv) {
  return betterAuth({
    appName: "Split It",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: ["openid", "email", "profile"],
        accessType: "online",
        includeGrantedScopes: false,
      },
    },
    // Better Auth's stateless mode keeps the session in an encrypted cookie.
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      cookieCache: {
        enabled: true,
        maxAge: 60 * 60 * 24 * 7,
        strategy: "jwe",
        refreshCache: true,
      },
    },
    account: { storeStateStrategy: "cookie", storeAccountCookie: true },
  });
}
