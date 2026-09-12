import { createAuth, isAuthConfigured, type AppEnv } from "./auth";

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/health" && request.method === "GET") {
      await env.DB.prepare("SELECT 1 FROM user LIMIT 1").all();
      return Response.json({ ok: true, authConfigured: isAuthConfigured(env) });
    }
    if (path.startsWith("/api/auth/") || path === "/api/me") {
      if (!isAuthConfigured(env)) {
        return Response.json({ error: "Configure the auth secret and Google OAuth credentials in .dev.vars." }, { status: 503 });
      }
      const origin = request.headers.get("Origin");
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && origin && origin !== new URL(env.BETTER_AUTH_URL).origin) {
        return Response.json({ error: "Untrusted origin" }, { status: 403 });
      }
      const auth = createAuth(env);
      if (path.startsWith("/api/auth/")) return auth.handler(request);
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      const session = await auth.api.getSession({ headers: request.headers });
      return Response.json(session ? { user: session.user } : { error: "Unauthorized" }, {
        status: session ? 200 : 401,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path.startsWith("/api/")) return Response.json({ error: "Not found" }, { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<AppEnv>;
