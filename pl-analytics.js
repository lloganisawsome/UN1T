/*
  Phantom Labs Analytics Tracker
  Safe-ish static-site analytics for Phantom Labs projects.

  Captures:
  - page views
  - anonymous sessions
  - browser/device/screen info
  - clicks on links/buttons/onclick elements

  Does NOT capture:
  - form field values
  - passwords/emails/phone numbers typed by visitors
  - IP addresses

  Requires Firebase Auth "Anonymous" provider enabled.
*/

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getDatabase,
  ref,
  push,
  set,
  update,
  serverTimestamp,
  increment
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBkAfF_Uv2pnSt6XokYHk8M-4f-lY3SPJ8",
  authDomain: "geography-534e0.firebaseapp.com",
  databaseURL: "https://geography-534e0-default-rtdb.firebaseio.com",
  projectId: "geography-534e0",
  storageBucket: "geography-534e0.firebasestorage.app",
  messagingSenderId: "152949402516",
  appId: "1:152949402516:web:eadcdecc26abaecf1cfd81",
  measurementId: "G-7JYV4SCF5F"
};

const BASE = "phantomAnalytics";
const config = window.PL_ANALYTICS_SITE || {};
const siteId = String(config.siteId || location.hostname || "unknown")
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, "-")
  .slice(0, 60);
const siteName = String(config.siteName || siteId).slice(0, 80);

if (!window.__PL_ANALYTICS_STARTED__ && config.enabled !== false) {
  window.__PL_ANALYTICS_STARTED__ = true;
  boot().catch((err) => {
    if (config.debug) console.warn("[Phantom Analytics]", err);
  });
}

async function boot() {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);

  await signInAnonymously(auth);

  const visitorId = getPersistentId("pl_visitor_id");
  const session = getSession();
  const startedAt = Date.now();

  await record(db, "page_view", { visitorId, session, startedAt });
  setInterval(() => writeSession(db, visitorId, session, startedAt, "heartbeat"), 30000);

  document.addEventListener(
    "click",
    (event) => {
      const click = getClickMeta(event.target);
      if (!click) return;
      record(db, "click", { visitorId, session, startedAt, click });
    },
    true
  );

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      writeSession(db, visitorId, session, startedAt, "hidden");
    }
  });
}

async function record(db, type, extra) {
  const payload = {
    ...basePayload(extra.visitorId, extra.session),
    type,
    click: extra.click || null,
    createdAt: serverTimestamp(),
    clientTime: new Date().toISOString()
  };

  await push(ref(db, `${BASE}/events`), payload);
  await writeSession(db, extra.visitorId, extra.session, extra.startedAt, type);
  await writeCounters(db, type);
}

async function writeSession(db, visitorId, session, startedAt, lastEventType) {
  await set(ref(db, `${BASE}/sessions/${session.id}`), {
    ...basePayload(visitorId, session),
    startedAt: session.startedAt,
    lastSeenAt: serverTimestamp(),
    lastSeenClientTime: new Date().toISOString(),
    durationSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
    lastEventType
  });
}

async function writeCounters(db, type) {
  const today = new Date().toISOString().slice(0, 10);
  const pageKey = clean(currentPath().replace(/[.#$/[\]]/g, "_"), 120) || "home";
  const updates = {
    [`${BASE}/summary/allTime/events`]: increment(1),
    [`${BASE}/summary/bySite/${siteId}/siteName`]: siteName,
    [`${BASE}/summary/bySite/${siteId}/events`]: increment(1),
    [`${BASE}/summary/bySite/${siteId}/lastSeenAt`]: serverTimestamp(),
    [`${BASE}/summary/daily/${today}/${siteId}/events`]: increment(1),
    [`${BASE}/summary/pages/${siteId}/${pageKey}/path`]: clean(currentPath(), 260),
    [`${BASE}/summary/pages/${siteId}/${pageKey}/events`]: increment(1)
  };

  if (type === "page_view") {
    updates[`${BASE}/summary/allTime/pageViews`] = increment(1);
    updates[`${BASE}/summary/bySite/${siteId}/pageViews`] = increment(1);
    updates[`${BASE}/summary/daily/${today}/${siteId}/pageViews`] = increment(1);
    updates[`${BASE}/summary/pages/${siteId}/${pageKey}/views`] = increment(1);
  }

  if (type === "click") {
    updates[`${BASE}/summary/allTime/clicks`] = increment(1);
    updates[`${BASE}/summary/bySite/${siteId}/clicks`] = increment(1);
    updates[`${BASE}/summary/daily/${today}/${siteId}/clicks`] = increment(1);
  }

  await update(ref(db), updates);
}

function basePayload(visitorId, session) {
  return {
    siteId,
    siteName,
    visitorId,
    sessionId: session.id,
    path: clean(currentPath(), 260),
    pageTitle: clean(document.title, 160),
    referrer: clean(document.referrer, 260),
    browser: detectBrowser(),
    os: detectOS(),
    deviceType: detectDevice(),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${screen.width}x${screen.height}`,
    language: clean(navigator.language, 32),
    timezone: clean(Intl.DateTimeFormat().resolvedOptions().timeZone, 80),
    userAgent: clean(navigator.userAgent, 260)
  };
}

function getClickMeta(target) {
  const el = target?.closest?.("a,button,label,[role='button'],[onclick],[data-analytics]");
  if (!el) return null;

  const label = clean(
    el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      el.innerText ||
      el.textContent ||
      el.id ||
      el.tagName,
    90
  );

  return {
    tag: clean(el.tagName, 20),
    id: clean(el.id, 80),
    classes: clean(el.className, 120),
    label,
    href: clean(el.tagName === "A" ? el.getAttribute("href") : "", 220)
  };
}

function getPersistentId(key) {
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return `blocked-${Math.random().toString(16).slice(2)}`;
  }
}

function getSession() {
  try {
    const now = Date.now();
    let data = JSON.parse(sessionStorage.getItem("pl_session") || "null");
    if (!data?.id || now - Number(data.lastSeen || 0) > 30 * 60 * 1000) {
      data = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random().toString(16).slice(2)}`,
        startedAt: now
      };
    }
    data.lastSeen = now;
    sessionStorage.setItem("pl_session", JSON.stringify(data));
    return data;
  } catch {
    return { id: `session-${Math.random().toString(16).slice(2)}`, startedAt: Date.now() };
  }
}

function currentPath() {
  return location.pathname + location.search + location.hash;
}

function clean(value, max = 140) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function detectBrowser() {
  const ua = navigator.userAgent || "";
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "Safari";
  if (/Firefox\//.test(ua)) return "Firefox";
  return "Other";
}

function detectOS() {
  const ua = navigator.userAgent || "";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Other";
}

function detectDevice() {
  const ua = navigator.userAgent || "";
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "mobile";
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  return "desktop";
}
