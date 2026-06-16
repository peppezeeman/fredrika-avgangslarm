"use strict";

const API_URL = "https://api.trafikinfo.trafikverket.se/v2/data.json";
const DEFAULT_ROUTE_ID = 19; // Skenäsleden
const ROUTE_KEY = "fredrika_route_id";
const API_KEY = "fredrika_api_key";

const els = {
  status: document.getElementById("statusPanel"),
  route: document.getElementById("routeSelect"),
  from: document.getElementById("fromHarbor"),
  next: document.getElementById("nextDeparture"),
  count: document.getElementById("countValue"),
  unit: document.getElementById("countUnit"),
  countWrap: document.querySelector(".countWrap"),
  clock: document.getElementById("clock"),
  dataStatus: document.getElementById("dataStatus"),
  armBtn: document.getElementById("armBtn"),
  wakeBtn: document.getElementById("wakeBtn"),
  fiveBtn: document.getElementById("testFiveBtn"),
  departBtn: document.getElementById("testDepartBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settings: document.getElementById("settings"),
  apiKey: document.getElementById("apiKey"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  nightBtn: document.getElementById("nightBtn"),
  fiveAudio: document.getElementById("fiveAudio"),
  departAudio: document.getElementById("departAudio"),
};

let nextDeparture = null;
let armed = false;
let wakeLock = null;
let lastFiveAlarmFor = null;
let lastDepartAlarmFor = null;
let audioCtx = null;

function setStatus(type, html) {
  els.status.className = `status ${type}`;
  els.status.innerHTML = html;
}

function addZero(n) { return String(n).padStart(2, "0"); }
function hhmm(date) { return `${addZero(date.getHours())}:${addZero(date.getMinutes())}`; }

async function trafikRequest(xml) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: xml,
  });
  if (!res.ok) throw new Error(`Trafikverket svarade ${res.status}`);
  return res.json();
}

function getKey() {
  return localStorage.getItem(API_KEY) || "";
}

function requireKey() {
  const key = getKey();
  if (!key) {
    setStatus("error", "<strong>API-nyckel saknas.</strong> Tryck på API-nyckel och klistra in nyckel från Trafikverket.");
    els.settings.classList.remove("hidden");
    return null;
  }
  return key;
}

async function loadRoutes() {
  const key = requireKey();
  if (!key) return;
  const xml = `<REQUEST><LOGIN authenticationkey="${key}" />` +
    `<QUERY objecttype="FerryRoute" schemaversion="1.2" orderby="Name asc">` +
    `<INCLUDE>Name</INCLUDE><INCLUDE>Id</INCLUDE></QUERY></REQUEST>`;
  const data = await trafikRequest(xml);
  const routes = data.RESPONSE.RESULT[0].FerryRoute || [];
  els.route.innerHTML = "";
  const saved = Number(localStorage.getItem(ROUTE_KEY) || DEFAULT_ROUTE_ID);
  for (const r of routes) {
    const opt = document.createElement("option");
    opt.value = r.Id;
    opt.textContent = r.Name;
    if (Number(r.Id) === saved) opt.selected = true;
    els.route.appendChild(opt);
  }
}

async function loadDeparture() {
  const key = requireKey();
  if (!key) return;
  const routeId = Number(localStorage.getItem(ROUTE_KEY) || DEFAULT_ROUTE_ID);
  els.dataStatus.textContent = "Hämtar avgång...";
  const xml = `<REQUEST><LOGIN authenticationkey="${key}" />` +
    `<QUERY limit="1" objecttype="FerryAnnouncement" schemaversion="1.2" orderby="DepartureTime">` +
    `<FILTER><EQ name="Route.Id" value="${routeId}" /><GT name="DepartureTime" value="$now" /></FILTER>` +
    `<INCLUDE>DepartureTime</INCLUDE><INCLUDE>Route.Name</INCLUDE><INCLUDE>Route.Id</INCLUDE><INCLUDE>FromHarbor.Name</INCLUDE>` +
    `</QUERY></REQUEST>`;
  const data = await trafikRequest(xml);
  const item = data.RESPONSE.RESULT[0].FerryAnnouncement?.[0];
  if (!item) throw new Error("Ingen kommande avgång hittades");
  nextDeparture = new Date(item.DepartureTime);
  els.next.textContent = hhmm(nextDeparture);
  els.from.textContent = item.FromHarbor.Name;
  els.dataStatus.textContent = `${item.Route.Name} · uppdaterad ${hhmm(new Date())}`;
  document.body.classList.remove("departing");
}

function tick() {
  const now = new Date();
  els.clock.textContent = `${hhmm(now)}:${addZero(now.getSeconds())}`;
  if (!nextDeparture) return;
  const seconds = Math.ceil((nextDeparture.getTime() - now.getTime()) / 1000);
  const minutes = Math.ceil(seconds / 60);

  els.countWrap.classList.toggle("orange", seconds <= 300 && seconds > 30);
  els.countWrap.classList.toggle("red", seconds <= 30);

  if (seconds < 120 && seconds >= 0) {
    els.count.textContent = Math.max(seconds, 0);
    els.unit.textContent = "sekunder";
  } else {
    els.count.textContent = Math.max(minutes, 0);
    els.unit.textContent = "minuter";
  }

  const depId = nextDeparture.toISOString();
  if (armed && seconds <= 300 && seconds > 0 && lastFiveAlarmFor !== depId) {
    lastFiveAlarmFor = depId;
    playAlarm("five");
  }
  if (armed && seconds <= 0 && lastDepartAlarmFor !== depId) {
    lastDepartAlarmFor = depId;
    document.body.classList.add("departing");
    playAlarm("depart");
    setTimeout(loadDepartureSafe, 55000);
  }
  if (seconds < -65) loadDepartureSafe();
}

async function unlockAudio() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  for (const a of [els.fiveAudio, els.departAudio]) {
    a.load();
    a.muted = true;
    try { await a.play(); } catch (_) {}
    a.pause(); a.currentTime = 0; a.muted = false;
  }
  armed = true;
  setStatus("ok", "<strong>Larm aktiverat.</strong> Ljudet är upplåst. Låt sidan vara öppen på skärmen.");
}

async function playAlarm(type) {
  const audio = type === "five" ? els.fiveAudio : els.departAudio;
  try {
    audio.pause(); audio.currentTime = 0;
    await audio.play();
  } catch (err) {
    setStatus("error", `<strong>LJUDET BLOCKERADES.</strong> Tryck på Aktivera larm igen. Fel: ${err.name}`);
    armed = false;
  }
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      els.wakeBtn.textContent = "Skärm vaken: På";
    } else {
      setStatus("warn", "Denna webbläsare saknar Wake Lock. Använd skärmens inställningar för att förhindra viloläge.");
    }
  } catch (err) {
    setStatus("warn", `Kunde inte aktivera skärm-vaken: ${err.message}`);
  }
}

async function loadDepartureSafe() {
  try { await loadDeparture(); }
  catch (err) { setStatus("error", `<strong>Datakälla fel.</strong> ${err.message}`); els.dataStatus.textContent = "Fel vid hämtning"; }
}

els.armBtn.addEventListener("click", unlockAudio);
els.wakeBtn.addEventListener("click", requestWakeLock);
els.fiveBtn.addEventListener("click", () => playAlarm("five"));
els.departBtn.addEventListener("click", () => playAlarm("depart"));
els.refreshBtn.addEventListener("click", loadDepartureSafe);
els.settingsBtn.addEventListener("click", () => els.settings.classList.toggle("hidden"));
els.saveKeyBtn.addEventListener("click", async () => {
  localStorage.setItem(API_KEY, els.apiKey.value.trim());
  els.settings.classList.add("hidden");
  await init();
});
els.route.addEventListener("change", async () => {
  localStorage.setItem(ROUTE_KEY, els.route.value);
  lastFiveAlarmFor = null; lastDepartAlarmFor = null;
  await loadDepartureSafe();
});
els.nightBtn.addEventListener("click", () => document.body.classList.toggle("night"));
document.addEventListener("visibilitychange", () => { if (wakeLock && document.visibilityState === "visible") requestWakeLock(); });

async function init() {
  els.apiKey.value = getKey();
  try {
    await loadRoutes();
    await loadDeparture();
    if (!armed) setStatus("warn", "<strong>Larm ej aktiverat.</strong> Tryck på Aktivera larm och testa ljudet.");
  } catch (err) {
    setStatus("error", `<strong>Startfel.</strong> ${err.message}`);
  }
}

setInterval(tick, 1000);
setInterval(loadDepartureSafe, 60000);
init();
