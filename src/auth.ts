import { betterAuth, type Auth } from "better-auth";
import { APIError } from "better-auth/api";

export interface AppEnv extends Env {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

export function isAuthConfigured(env: AppEnv): boolean {
  return Boolean(env.BETTER_AUTH_URL && env.BETTER_AUTH_SECRET?.length >= 32 && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function createAuth(env: AppEnv): Pick<Auth, 'handler' | 'api'> {
  // Keep this auth instance request-local so concurrent sign-ins cannot share identities.
  let verifiedAppUserId: string | null = null;
  return betterAuth({
    appName: "Split It",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: { enabled: false },
    databaseHooks: {
      user: { create: { before: async (user) => {
        if (!verifiedAppUserId) throw new APIError("FORBIDDEN", { message: "A verified Google identity is required." });
        // Provider parsing drops input:false fields; inject only the verified request-local ID afterward.
        return { data: { ...user, appUserId: verifiedAppUserId } };
      } } },
    },
    user: { additionalFields: { appUserId: { type: "string", required: false, input: false } } },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: ["openid", "email", "profile"],
        accessType: "online",
        includeGrantedScopes: false,
        mapProfileToUser: async (profile) => {
          verifiedAppUserId = await resolveGoogleUser(env.DB, profile);
          return {};
        },
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

interface GoogleIdentity {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
}

export async function resolveGoogleUser(db: D1Database, profile: GoogleIdentity): Promise<string> {
  if (!profile.sub || !profile.email_verified || !profile.email || !profile.name) throw new APIError("FORBIDDEN", { message: "Google sign-in requires a verified email and a complete profile." });
  const candidate = crypto.randomUUID();
  const now = Date.now();
  const results = await db.batch<{ id: string }>([
    db.prepare("INSERT INTO users(id,display_name,email,avatar_url,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM user_identities WHERE provider='google' AND provider_subject=?)").bind(candidate, profile.name, profile.email.trim(), profile.picture ?? null, now, now, profile.sub),
    db.prepare("INSERT INTO user_identities(provider,provider_subject,user_id,created_at) SELECT 'google',?,?,? WHERE NOT EXISTS(SELECT 1 FROM user_identities WHERE provider='google' AND provider_subject=?)").bind(profile.sub, candidate, now, profile.sub),
    db.prepare("UPDATE users SET display_name=?,email=?,avatar_url=?,updated_at=? WHERE id=(SELECT user_id FROM user_identities WHERE provider='google' AND provider_subject=?) RETURNING id").bind(profile.name, profile.email.trim(), profile.picture ?? null, now, profile.sub),
  ]);
  const row = results[2]?.results[0];
  if (!row || typeof row.id !== 'string') throw new Error('Could not resolve the Google identity. Sign in again.');
  return row.id;
}
