import { EDfunction } from "./backend/ecole_directe/index.js";

// ed-client-worker — internal ÉcoleDirecte API.
//
// This worker is NOT meant to be reached from the public internet: it is
// called by other workers of the same Cloudflare account through a service
// binding (e.g. env.ED_CLIENT.fetch(...)). It owns the whole ED session —
// login, cookies, token cache and the 2FA (QCM) relay — so callers just ask
// for a feature and get the data back.
//
// Routes (subpath of the request path):
//   GET  /info          student account info (also triggers login / QCM)
//   GET  /grades        grades            (header "filter: true" = light)
//   GET  /averages      grade averages
//   GET  /new-grades    grades since last check (used by the cron workflow)
//   GET  /homeworks     homework list     (header "filter: true" = light)
//   POST /homeworks     { id, done }      mark homework done/undone
//   GET  /timetable     timetable         (header "filter: true" = week grid)
//   POST /qcm           { choice }        answer the pending 2FA questionnaire
//
// When ÉcoleDirecte requires the 2FA questionnaire, every route returns
// { qcm_required: true, question, propositions } — the caller must relay it
// to the end user and POST the answer to /qcm before retrying.

const JSON_HEADERS = { "Content-Type": "application/json" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    let body = null;
    const contentType = request.headers.get("content-type") || "";
    if (method !== "GET" && method !== "HEAD") {
      if (contentType.includes("multipart/form-data")) {
        body = await request.formData();
      } else {
        try {
          body = JSON.parse(await request.text());
        } catch {
          body = {};
        }
      }
    }

    try {
      const subpath = url.pathname.replace(/^\/+/, "");
      const result = await EDfunction(env, subpath, method, request.headers, body);
      return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
    } catch (e) {
      console.error("ED API ERROR:", e?.stack || e);
      return new Response(JSON.stringify({ error: e?.message || "ED error" }), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }
  },
};
