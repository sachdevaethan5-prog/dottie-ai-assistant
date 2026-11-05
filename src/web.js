// The web for the user's questions: a search through OpenRouter's web plugin (Exa, about $0.007 a search)
// with a daily cap, and reading one page they send a link to.
import { llm, getState, setState } from './agent.js';
import { htmlText } from './canvas.js';

export async function webSearch(env, query) {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: env.TIMEZONE });
  const used = Number(await getState(env, `web_searches:${day}`)) || 0;
  const cap = Number(env.WEB_SEARCHES_PER_DAY || 30);
  if (used >= cap) return `Daily web search limit reached (${cap}); answer from what you know and say you couldn't look it up.`;
  await setState(env, `web_searches:${day}`, String(used + 1));
  const msg = await llm(env, [
    { role: 'system', content: `Answer the question from the web results, briefly and factually (dates, times, addresses, prices when they matter). Today is ${day}. If the results don't answer it, say so.` },
    { role: 'user', content: String(query).slice(0, 500) },
  ], null, false, undefined, { plugins: [{ id: 'web', engine: 'exa', max_results: 5 }] });
  const sources = (msg.annotations || []).filter((a) => a.type === 'url_citation')
    .map((a) => `${a.url_citation.title || 'source'}: ${a.url_citation.url}`);
  return { answer: msg.content, sources: [...new Set(sources)].slice(0, 5) };
}

// One web page as text: what a link they sent says.
export async function webRead(env, url) {
  let u;
  try { u = new URL(url); } catch { return 'That is not a web link.'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'Only http and https links can be read.';
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; dottie-ai-assistant/1.0)', accept: 'text/html,text/plain,*/*' } });
  if (!r.ok) return `The page answered ${r.status}; it may need a login.`;
  const type = r.headers.get('content-type') || '';
  if (!/text|html|json|xml/.test(type)) return `That link is a ${type || 'file'}, not a page; ask them to send the file itself.`;
  const body = (await r.text()).slice(0, 2_000_000);
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const text = /html/.test(type) ? htmlText(body.replace(/<(head|nav|footer|header|aside|noscript|svg)[\s\S]*?<\/\1>/gi, '')) : body;
  return { title, text: text.slice(0, 10000) };
}

// Weather where the user is (LAT, LON in wrangler.toml) from Open-Meteo: free, no key.
const SKY = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy', 45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow',
  80: 'showers', 81: 'showers', 82: 'heavy showers', 85: 'snow showers', 86: 'snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail' };

export function weatherSummary(j, dayIndex = 0) {
  const d = j.daily;
  const date = d.time[dayIndex];
  const hours = j.hourly.time.map((t, i) => ({ t, rain: j.hourly.precipitation_probability[i], temp: j.hourly.temperature_2m[i] })).filter((h) => h.t.startsWith(date));
  const part = (from, to) => hours.filter((h) => Number(h.t.slice(11, 13)) >= from && Number(h.t.slice(11, 13)) < to);
  const rainy = (from, to) => Math.max(0, ...part(from, to).map((h) => h.rain ?? 0));
  return {
    date, sky: SKY[d.weather_code[dayIndex]] || 'mixed', high_f: Math.round(d.temperature_2m_max[dayIndex]), low_f: Math.round(d.temperature_2m_min[dayIndex]),
    rain_chance: { morning: rainy(6, 12), afternoon: rainy(12, 18), evening: rainy(18, 24) },
    temp_f: { '8am': Math.round(part(8, 9)[0]?.temp ?? NaN), '3pm': Math.round(part(15, 16)[0]?.temp ?? NaN), '9pm': Math.round(part(21, 22)[0]?.temp ?? NaN) },
  };
}

export async function weather(env, days = 2) {
  if (!env.LAT || !env.LON) return 'Weather is not set up (LAT and LON are empty in wrangler.toml).';
  const q = new URLSearchParams({
    latitude: env.LAT, longitude: env.LON, timezone: env.TIMEZONE, temperature_unit: 'fahrenheit', forecast_days: String(Math.min(Number(days) || 2, 7)),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min', hourly: 'temperature_2m,precipitation_probability',
  });
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
  if (!r.ok) return `Weather is not available right now (${r.status}).`;
  const j = await r.json();
  return j.daily.time.map((_, i) => weatherSummary(j, i));
}
