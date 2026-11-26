import { setCacheValue } from "../cache/set.js";
import { getCacheValue } from "../cache/get.js";

const ED_USER_AGENT = "Lumaris-Dashboard/1.0 (+https://lumaris.fr)";

function edUserAgent(env) {
  return env.USER_AGENT || ED_USER_AGENT;
}

const norm = (s) =>
  String(s)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

// Tries to answer the 2FA questionnaire automatically using the account
// secrets (BORN_DAY / BORN_MONTH / BORN_YEAR / ED_CLASS / ED_TEACHER).
// Returns the matching proposition, or null when the question isn't handled
// or the secrets aren't configured — caller then falls back to the manual
// client-side QCM flow.
function tryAutoAnswerQCM(question, propositions, env) {
  const secrets = {
    jour: env.BORN_DAY,
    mois: env.BORN_MONTH,
    annee: env.BORN_YEAR,
    professeur: env.ED_TEACHER,
    classe: env.ED_CLASS,
  };
  const q = norm(question);
  let expected = null;
  if (q.includes("jour")) expected = secrets.jour;
  else if (q.includes("mois")) expected = secrets.mois;
  else if (q.includes("annee") || q.includes("année") || q.includes("ann")) expected = secrets.annee;
  else if (q.includes("professeur")) expected = secrets.professeur;
  else if (q.includes("classe")) expected = secrets.classe;
  if (expected === null || expected === undefined || expected === "") return null;
  const match = propositions.find((p) => norm(p) === norm(expected));
  return match || null;
}

// Posts the chosen proposition to ÉcoleDirecte, then re-logins with the
// returned fa factors and caches the session. Shared by the automatic and
// manual (client-answered) QCM paths.
async function completeQCMLogin(env, pending, selected) {
  const userAgent = edUserAgent(env);
  const user = env.ED_USERNAME || env.ED_USER;
  const password = env.ED_PASSWORD;

  const body = new URLSearchParams();
  body.set("data", JSON.stringify({
    choix: btoa(unescape(encodeURIComponent(selected)))
  }));
  const resQcm = await fetch(
    "https://api.ecoledirecte.com/v3/connexion/doubleauth.awp?verbe=post", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Token": pending.token,
      "Cookie": (pending.cookies || []).join("; "),
      "User-Agent": userAgent
    },
    body: body.toString()
  });
  const qcmJson = await resQcm.json();
  if (qcmJson.code !== 200 || !qcmJson.data?.cn || !qcmJson.data?.cv) {
    throw new Error(`Échec QCM: ${JSON.stringify(qcmJson)}`);
  }

  // Re-login with the fa factors — same payload shape as a fresh login.
  const gtkRes = await fetch("https://api.ecoledirecte.com/v3/login.awp?gtk=1&v=4.75.0", {
    method: "GET",
    headers: {
      "User-Agent": userAgent,
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://www.ecoledirecte.com/",
      "Origin": "https://www.ecoledirecte.com"
    }
  });
  const setCookies = [];
  if (typeof gtkRes.headers.getSetCookie === "function") {
    setCookies.push(...gtkRes.headers.getSetCookie());
  }
  const rawSetCookie = gtkRes.headers.get("set-cookie");
  if (rawSetCookie && setCookies.length === 0) setCookies.push(rawSetCookie);
  const gtk = setCookies.map((c) => c.match(/GTK=([^;]+)/)?.[1]).find(Boolean);
  if (!gtk) throw new Error("GTK introuvable");

  const loginBody = new URLSearchParams();
  loginBody.append("data", JSON.stringify({
    identifiant: user,
    motdepasse: password,
    isRelogin: false,
    uuid: "",
    fa: [{ cn: qcmJson.data.cn, cv: qcmJson.data.cv }]
  }));
  const reloginRes = await fetch("https://api.ecoledirecte.com/v3/login.awp?v=4.75.0", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://www.ecoledirecte.com/",
      "Origin": "https://www.ecoledirecte.com",
      "X-Gtk": gtk,
      "Cookie": setCookies.join("; ")
    },
    body: loginBody.toString()
  });
  const reloginText = await reloginRes.text();
  let reloginJson;
  try {
    reloginJson = JSON.parse(reloginText);
  } catch {
    throw new Error(`Re-login après QCM: réponse invalide ${reloginText.slice(0, 200)}`);
  }
  if (reloginJson.code !== 200) {
    throw new Error(`Re-login après QCM échoué: ${JSON.stringify(reloginJson)}`);
  }
  const tokenFromHeader = reloginRes.headers.get("x-token") || reloginRes.headers.get("X-Token") || "";
  const token = tokenFromHeader || reloginJson.token || "";

  const session = { json: reloginJson, gtk, cookies: setCookies, token };
  await setCacheValue("edToken", session);
  await setCacheValue("edTokenTime", Math.floor(Date.now() / 60000));
  return session;
}

// Returns either a logged-in session ({ token, json, gtk, cookies }) or a
// { qcm_required: true, question, propositions } marker when ÉcoleDirecte
// asks for the 2FA questionnaire — the client answers it via EDanswerQCM.
export async function EDinformations(env, new_token) {
  // Answering the informations if a correct and actual response is saved
  if (
    (Math.floor(Date.now() / 60000) - await getCacheValue("edTokenTime")) < 29 &&
    new_token !== true
  ) {
    return await getCacheValue("edToken")
  };

  const userAgent = edUserAgent(env);
  const apiVersion = "4.75.0";
  const user = env.ED_USERNAME || env.ED_USER;
  const password = env.ED_PASSWORD;
  if (!user || !password) {
    throw new Error("Identifiants ÉcoleDirecte manquants (ED_USERNAME / ED_PASSWORD)");
  }

  // Get the gtk and login
  async function getGtk() {
    const gtkRes = await fetch(`https://api.ecoledirecte.com/v3/login.awp?gtk=1&v=${apiVersion}`, {
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.ecoledirecte.com/",
        "Origin": "https://www.ecoledirecte.com"
      }
    });
    const cookies = [];
    if (typeof gtkRes.headers.getSetCookie === "function") {
      cookies.push(...gtkRes.headers.getSetCookie());
    }
    const rawSetCookie = gtkRes.headers.get("set-cookie");
    if (rawSetCookie && cookies.length === 0) cookies.push(rawSetCookie);
    const gtk = cookies.map((c) => c.match(/GTK=([^;]+)/)?.[1]).find(Boolean);
    if (!gtk) throw new Error("GTK introuvable");
    return { gtk, cookies };
  }
  async function login(extraFa = null) {
    const { gtk, cookies } = await getGtk();
    const payload = {
      identifiant: user,
      motdepasse: password,
      isRelogin: false,
      uuid: ""
    };
    if (Array.isArray(extraFa) && extraFa.length > 0) payload.fa = extraFa;
    const body = new URLSearchParams();
    body.append("data", JSON.stringify(payload));
    const res = await fetch(`https://api.ecoledirecte.com/v3/login.awp?v=${apiVersion}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent,
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.ecoledirecte.com/",
        "Origin": "https://www.ecoledirecte.com",
        "X-Gtk": gtk,
        "Cookie": cookies.join("; ")
      },
      body: body.toString()
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Réponse login invalide: ${text.slice(0, 200)}`);
    }
    const tokenFromHeader = res.headers.get("x-token") || res.headers.get("X-Token") || "";
    const token = tokenFromHeader || json.token || "";
    return { json, gtk, cookies, token };
  }

  const first = await login();
  if (first.json.code === 200) {
    return { token: first.token || first.json.token, account: first.json.data };
  }
  if (first.json.code !== 250) {
    throw new Error(first.json.message || `Login failed with code ${first.json.code}`);
  }
  if (!first.token) {
    throw new Error(`Token absent sur le login 250: ${JSON.stringify(first.json)}`);
  }

  // QCM 2FA — forwarded to the client, answered via EDanswerQCM.
  const challengeRes = await fetch("https://api.ecoledirecte.com/v3/connexion/doubleauth.awp?verbe=get", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://www.ecoledirecte.com/",
      "Origin": "https://www.ecoledirecte.com",
      "X-Token": first.token,
      "Cookie": first.cookies.join("; ")
    },
    body: new URLSearchParams({
      data: JSON.stringify({})
    }).toString()
  });
  const challengeText = await challengeRes.text();
  let challenge = null;
  try {
    challenge = JSON.parse(challengeText);
  } catch {
    throw new Error(`Réponse QCM invalide: ${challengeText.slice(0, 200)}`);
  }
  if (challenge.code === 520) {
    throw new Error(`Token invalide pendant l'accès au QCM: ${challengeText.slice(0, 200)}`);
  }
  if (challenge.code !== 200 || !challenge.data) {
    throw new Error(`QCM 2FA introuvable: ${challengeText.slice(0, 200)}`);
  }
  const question = challenge.data.question ? atob(challenge.data.question) : null;
  const propositions = Array.isArray(challenge.data.propositions)
    ? challenge.data.propositions.map((p) => {
        try { return atob(p); } catch { return ""; }
      }).filter(Boolean)
    : [];
  if (!question || propositions.length === 0) {
    throw new Error(`QCM 2FA introuvable: ${challengeText.slice(0, 200)}`);
  }

  // Automatic answer first — uses the account secrets configured on this
  // worker. Falls back to the manual client-side QCM when the question
  // isn't handled or the secrets are missing.
  const autoAnswer = tryAutoAnswerQCM(question, propositions, env);
  if (autoAnswer) {
    try {
      const session = await completeQCMLogin(env, { token: first.token, cookies: first.cookies }, autoAnswer);
      await setCacheValue("edQcmPending", null);
      return session;
    } catch (e) {
      console.log(`Auto QCM failed (${e.message}), falling back to manual QCM`);
    }
  }

  // Stash the pending session so EDanswerQCM can complete the login.
  await setCacheValue("edQcmPending", {
    token: first.token,
    cookies: first.cookies,
    propositions,
  });

  return {
    qcm_required: true,
    question,
    propositions,
  };
}

// Completes a pending 2FA login: posts the user's chosen proposition back to
// ÉcoleDirecte, then re-logins with the returned fa factors and caches the
// session like a normal login.
export async function EDanswerQCM(env, choiceIndex) {
  const pending = await getCacheValue("edQcmPending");
  if (!pending?.token || !Array.isArray(pending.propositions)) {
    throw new Error("Aucun questionnaire en attente — relancez la synchronisation");
  }
  const selected = pending.propositions[Number(choiceIndex)];
  if (!selected) {
    throw new Error("Réponse QCM invalide");
  }

  try {
    const session = await completeQCMLogin(env, pending, selected);
    await setCacheValue("edQcmPending", null);
    return session;
  } catch (e) {
    await setCacheValue("edQcmPending", null);
    throw e;
  }
}
