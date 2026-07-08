import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

const AMAP_KEY = process.env.AMAP_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

const AMAP_BASE_URL = "https://restapi.amap.com/v3";
const AMAP_V5_BASE_URL = "https://restapi.amap.com/v5";

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function toQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  }
  return query.toString();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(data)}`);
  }

  return data;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAmapRateLimited(data) {
  return (
    data?.info === "CUQPS_HAS_EXCEEDED_THE_LIMIT" ||
    data?.info === "USER_DAILY_QUERY_OVER_LIMIT" ||
    data?.infocode === "10020" ||
    data?.infocode === "10044"
  );
}

async function amapGet(endpoint, params, baseUrl = AMAP_BASE_URL) {
  requireEnv("AMAP_KEY", AMAP_KEY);
  const url = `${baseUrl}${endpoint}?${toQuery({ key: AMAP_KEY, ...params })}`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const data = await fetchJson(url);
    if (!data.status || data.status === "1") {
      return data;
    }

    if (isAmapRateLimited(data) && attempt < 3) {
      await sleep(400 * (attempt + 1));
      continue;
    }

    throw new Error(`Amap error ${data.infocode || ""}: ${data.info || JSON.stringify(data)}`);
  }

  throw new Error("Amap request failed after retries");
}

async function geocode(address, city) {
  const data = await amapGet("/geocode/geo", { address, city });
  const geocodeResult = data.geocodes?.[0];
  if (!geocodeResult?.location) {
    throw new Error(`No geocode result for: ${address}`);
  }
  return {
    formatted_address: geocodeResult.formatted_address,
    location: geocodeResult.location,
    city: geocodeResult.city || city,
    adcode: geocodeResult.adcode,
  };
}

async function searchPoi({ keywords, city, types, page_size = 10 }) {
  const data = await amapGet("/place/text", {
    keywords,
    city,
    types,
    citylimit: city ? "true" : undefined,
    offset: Math.min(Math.max(Number(page_size) || 10, 1), 25),
    page: 1,
    extensions: "all",
  });

  return (data.pois || []).map((poi) => ({
    id: poi.id,
    name: poi.name,
    type: poi.type,
    city: poi.cityname,
    adname: poi.adname,
    address: Array.isArray(poi.address) ? poi.address.join("") : poi.address,
    location: poi.location,
    tel: Array.isArray(poi.tel) ? poi.tel.join(", ") : poi.tel,
    rating: poi.biz_ext?.rating,
    cost: poi.biz_ext?.cost,
    open_time: poi.biz_ext?.open_time,
    photos: (poi.photos || []).slice(0, 3).map((photo) => photo.url),
  }));
}

function dedupePois(pois) {
  const seen = new Set();
  const result = [];
  for (const poi of pois) {
    const key = poi.id || `${poi.name}-${poi.location}`;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(poi);
  }
  return result;
}

async function collectPois({ city, types, page_size, keywords }) {
  const all = [];
  for (const keyword of keywords) {
    if (all.length >= page_size) {
      break;
    }

    try {
      all.push(...(await searchPoi({ keywords: keyword, city, types, page_size })));
      await sleep(220);
    } catch (error) {
      if (!String(error.message).includes("CUQPS_HAS_EXCEEDED_THE_LIMIT")) {
        throw error;
      }
      await sleep(900);
    }
  }

  if (all.length < Math.min(3, page_size)) {
    for (const keyword of keywords) {
      if (all.length >= page_size) {
        break;
      }
      all.push(...(await searchPoi({ keywords: keyword, city, page_size })));
      await sleep(220);
    }
  }

  return dedupePois(all).slice(0, page_size);
}

async function weather(city, extensions = "base") {
  const data = await amapGet("/weather/weatherInfo", { city, extensions });
  return {
    city,
    type: extensions,
    lives: data.lives || [],
    forecasts: data.forecasts || [],
  };
}

async function route({ origin, destination, city, mode = "walking" }) {
  let originLocation = origin;
  let destinationLocation = destination;

  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(origin)) {
    originLocation = (await geocode(origin, city)).location;
  }
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(destination)) {
    destinationLocation = (await geocode(destination, city)).location;
  }

  if (mode === "driving") {
    return amapGet("/direction/driving", {
      origin: originLocation,
      destination: destinationLocation,
      extensions: "base",
    });
  }

  if (mode === "transit") {
    return amapGet("/direction/transit/integrated", {
      origin: originLocation,
      destination: destinationLocation,
      city,
      extensions: "base",
    });
  }

  return amapGet("/direction/walking", {
    origin: originLocation,
    destination: destinationLocation,
  });
}

function slimRoute(routeData, mode) {
  if (mode === "transit") {
    return (routeData.route?.transits || []).slice(0, 3).map((item) => ({
      duration_minutes: Math.round(Number(item.duration || 0) / 60),
      walking_distance_meters: item.walking_distance,
      cost: item.cost,
      segments: (item.segments || []).map((segment) => ({
        bus: segment.bus?.buslines?.[0]?.name,
        railway: segment.railway?.name,
        walking: segment.walking?.distance ? `${segment.walking.distance}m` : undefined,
      })),
    }));
  }

  const paths = routeData.route?.paths || [];
  return paths.slice(0, 3).map((item) => ({
    distance_meters: item.distance,
    duration_minutes: Math.round(Number(item.duration || 0) / 60),
    strategy: item.strategy,
    steps: (item.steps || []).slice(0, 8).map((step) => step.instruction),
  }));
}

async function deepseek(messages, temperature = 0.4) {
  requireEnv("DEEPSEEK_API_KEY", DEEPSEEK_API_KEY);
  const data = await fetchJson(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature,
      messages,
    }),
  });

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`DeepSeek returned no content: ${JSON.stringify(data)}`);
  }
  return content;
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function parseJsonMaybe(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    return null;
  }

  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizePlanForHtml(plan) {
  if (typeof plan === "string") {
    return parseJsonMaybe(plan) || { title: "旅行攻略", summary: plan, days: [] };
  }
  return plan || { title: "旅行攻略", days: [] };
}

function cityShortName(city) {
  return String(city || "").replace(/[市省自治区特别行政区]+$/g, "");
}

function hasPlanDrift(plan, destination, sourcePois) {
  const text = typeof plan === "string" ? plan : JSON.stringify(plan);
  const shortDestination = cityShortName(destination);
  const hasDestination = text.includes(destination) || (shortDestination && text.includes(shortDestination));
  const knownPoiNames = sourcePois.map((poi) => poi.name).filter(Boolean).slice(0, 25);
  const hasKnownPoi = knownPoiNames.some((name) => text.includes(name));
  const otherCities = [
    "北京",
    "天津",
    "广州",
    "深圳",
    "杭州",
    "南京",
    "苏州",
    "成都",
    "重庆",
    "西安",
    "武汉",
    "长沙",
    "厦门",
    "青岛",
  ].filter((name) => !destination.includes(name) && name !== shortDestination);
  const hasOtherCity = otherCities.some((name) => text.includes(name));

  return (hasOtherCity && !hasDestination) || (sourcePois.length >= 3 && !hasKnownPoi);
}

async function buildTripPlan(input) {
  const city = input.destination;
  const days = Math.min(Math.max(Number(input.days || 1), 1), 10);
  const interests = input.interests || "经典景点、本地美食、轻松路线";
  const travelers = input.travelers || "成人";
  const budget = input.budget || "适中";
  const pace = input.pace || "适中";
  const origin = input.origin;

  const weatherInfo = await weather(city, input.forecast ? "all" : "base");
  await sleep(220);
  const attractions = await collectPois({
    city,
    types: "110000",
    page_size: 12,
    keywords: ["景点", "必游", "热门景区", "博物馆", "公园"],
  });
  await sleep(220);
  const restaurants = await collectPois({
    city,
    types: "050000",
    page_size: 12,
    keywords: ["美食", "本帮菜", "小吃", "餐厅", "咖啡"],
  });
  await sleep(220);
  const hotels = input.include_hotels
    ? await collectPois({
        city,
        types: "100000",
        page_size: 8,
        keywords: ["酒店", "民宿", "住宿"],
      })
    : [];

  if (attractions.length < 3) {
    throw new Error(`高德没有为 ${city} 返回足够的景点数据，请换一个城市名、adcode 或稍后重试。`);
  }

  const routeSamples = [];
  const routePois = attractions.slice(0, Math.min(attractions.length - 1, 4));
  for (let index = 0; index < routePois.length - 1; index += 1) {
    const from = routePois[index];
    const to = routePois[index + 1];
    if (from.location && to.location) {
      try {
        const routeData = await route({
          origin: from.location,
          destination: to.location,
          city,
          mode: input.transport || "transit",
        });
        routeSamples.push({
          from: from.name,
          to: to.name,
          mode: input.transport || "transit",
          options: slimRoute(routeData, input.transport || "transit"),
        });
      } catch (error) {
        routeSamples.push({ from: from.name, to: to.name, error: error.message });
      }
    }
  }

  const context = {
    request: {
      destination: city,
      origin,
      days,
      start_date: input.start_date,
      travelers,
      interests,
      budget,
      pace,
      transport: input.transport || "transit",
    },
    weather: weatherInfo,
    attractions,
    restaurants,
    hotels,
    route_samples: routeSamples,
  };

  const prompt = [
    `你是一个严谨的中文旅行规划师。目的地必须是【${city}】。请根据高德地图数据生成旅行攻略。`,
    "要求：",
    `1. 只能规划【${city}】及其周边合理范围内的地点，禁止把目的地写成其他城市。`,
    "2. 必须优先从候选景点、餐厅、酒店中选点，不要虚构不存在的地点。",
    "3. 每天按上午、下午、晚上安排，包含地点、玩法、餐饮、交通建议、预计耗时。",
    "4. 行程要顺路，节奏符合用户偏好。",
    "5. 给出避坑提醒、雨天备选、预算建议。",
    "6. 返回严格 JSON，不要 Markdown，不要代码块。",
    "JSON 结构：",
    "{",
    "  \"title\": \"...\",",
    "  \"summary\": \"...\",",
    "  \"weather_tips\": [\"...\"],",
    "  \"days\": [",
    "    {",
    "      \"day\": 1,",
    "      \"theme\": \"...\",",
    "      \"schedule\": [",
    "        {\"period\": \"上午\", \"place\": \"...\", \"location\": \"经度,纬度或空\", \"plan\": \"...\", \"food\": \"...\", \"transport\": \"...\", \"duration\": \"...\"}",
    "      ]",
    "    }",
    "  ],",
    "  \"food_recommendations\": [{\"name\": \"...\", \"reason\": \"...\", \"cost\": \"...\"}],",
    "  \"hotel_suggestions\": [{\"name\": \"...\", \"reason\": \"...\", \"cost\": \"...\"}],",
    "  \"budget\": {\"level\": \"...\", \"estimate\": \"...\", \"tips\": [\"...\"]},",
    "  \"rainy_day_backup\": [\"...\"],",
    "  \"warnings\": [\"...\"]",
    "}",
  ].join("\n");

  const content = await deepseek([
    { role: "system", content: prompt },
    { role: "user", content: JSON.stringify(context, null, 2) },
  ]);

  let plan = parseJsonMaybe(content) || content;
  const sourcePois = [...attractions, ...restaurants, ...hotels];
  if (hasPlanDrift(plan, city, sourcePois)) {
    const repaired = await deepseek(
      [
        { role: "system", content: prompt },
        {
          role: "user",
          content: [
            `上一次结果偏离了目的地。请重新生成，目的地必须是【${city}】，并且主要地点必须来自 source_data 中的候选 POI。`,
            "source_data:",
            JSON.stringify(context, null, 2),
            "wrong_result:",
            typeof plan === "string" ? plan : JSON.stringify(plan, null, 2),
          ].join("\n"),
        },
      ],
      0.2
    );
    plan = parseJsonMaybe(repaired) || repaired;
  }

  return {
    plan,
    source_data: context,
  };
}

function createH5(planInput, sourceData = {}) {
  const plan = normalizePlanForHtml(planInput);
  const title = plan.title || `${sourceData.request?.destination || ""}旅行攻略`;
  const days = Array.isArray(plan.days) ? plan.days : [];
  const allStops = days.flatMap((day) =>
    (day.schedule || []).map((item) => ({
      day: day.day,
      period: item.period,
      place: item.place,
      location: item.location,
      plan: item.plan,
      transport: item.transport,
      duration: item.duration,
    }))
  );

  const stopsJson = JSON.stringify(allStops).replace(/</g, "\\u003c");
  const dayHtml = days
    .map((day) => {
      const items = (day.schedule || [])
        .map(
          (item) => `<li>
            <div class="time">${escapeHtml(item.period || "")}</div>
            <div class="stop">
              <h3>${escapeHtml(item.place || "")}</h3>
              <p>${escapeHtml(item.plan || "")}</p>
              <p class="meta">${escapeHtml([item.duration, item.transport, item.food].filter(Boolean).join(" · "))}</p>
            </div>
          </li>`
        )
        .join("");
      return `<section class="day">
        <div class="day-head">
          <span>Day ${escapeHtml(day.day || "")}</span>
          <h2>${escapeHtml(day.theme || "")}</h2>
        </div>
        <ol>${items}</ol>
      </section>`;
    })
    .join("");

  const foodHtml = (plan.food_recommendations || [])
    .map((item) => `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.reason || "")}</span></li>`)
    .join("");
  const warningHtml = (plan.warnings || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const weatherHtml = (plan.weather_tips || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #19212a;
      --muted: #65717f;
      --line: #dfe5ea;
      --paper: #fbfcfd;
      --brand: #0d8b74;
      --warm: #f5b44d;
      --blue: #4d7cfe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: var(--ink);
      background: var(--paper);
      letter-spacing: 0;
    }
    header {
      min-height: 54vh;
      display: grid;
      align-items: end;
      padding: 32px min(6vw, 72px);
      background:
        linear-gradient(180deg, rgba(9, 29, 40, .12), rgba(9, 29, 40, .74)),
        url("https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1800&q=80") center/cover;
      color: white;
    }
    h1 {
      max-width: 980px;
      margin: 0;
      font-size: clamp(36px, 7vw, 78px);
      line-height: 1.02;
      font-weight: 800;
    }
    header p {
      max-width: 820px;
      margin: 18px 0 0;
      font-size: clamp(16px, 2vw, 22px);
      line-height: 1.65;
    }
    main {
      width: min(1120px, calc(100% - 32px));
      margin: 28px auto 72px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 28px;
    }
    .day {
      padding: 28px 0;
      border-bottom: 1px solid var(--line);
    }
    .day-head span {
      display: inline-block;
      color: var(--brand);
      font-weight: 700;
      margin-bottom: 6px;
    }
    h2 {
      margin: 0 0 18px;
      font-size: 28px;
    }
    ol {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 14px;
    }
    li {
      display: grid;
      grid-template-columns: 72px 1fr;
      gap: 16px;
      align-items: start;
    }
    .time {
      color: var(--brand);
      font-weight: 800;
      padding-top: 3px;
    }
    .stop {
      border-left: 3px solid var(--warm);
      padding-left: 16px;
    }
    h3 {
      margin: 0 0 8px;
      font-size: 20px;
    }
    p {
      margin: 0 0 8px;
      line-height: 1.75;
    }
    .meta {
      color: var(--muted);
      font-size: 14px;
    }
    aside {
      position: sticky;
      top: 18px;
      align-self: start;
      display: grid;
      gap: 18px;
    }
    .panel {
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      box-shadow: 0 12px 30px rgba(25, 33, 42, .06);
    }
    .panel h2 {
      font-size: 18px;
      margin-bottom: 12px;
    }
    .panel ul {
      margin: 0;
      padding-left: 18px;
      line-height: 1.7;
    }
    .panel li {
      display: list-item;
      margin: 7px 0;
    }
    .panel strong {
      display: block;
    }
    .panel span {
      color: var(--muted);
    }
    .map-links {
      display: grid;
      gap: 8px;
    }
    .map-links a {
      color: var(--blue);
      text-decoration: none;
      overflow-wrap: anywhere;
    }
    @media (max-width: 860px) {
      header {
        min-height: 46vh;
        padding: 26px 18px;
      }
      main {
        grid-template-columns: 1fr;
        width: min(100% - 28px, 680px);
      }
      aside {
        position: static;
      }
      li {
        grid-template-columns: 56px 1fr;
        gap: 10px;
      }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(plan.summary || "")}</p>
    </div>
  </header>
  <main>
    <div>${dayHtml || "<p>暂无行程内容。</p>"}</div>
    <aside>
      <section class="panel">
        <h2>天气提示</h2>
        <ul>${weatherHtml || "<li>出行前再次确认天气。</li>"}</ul>
      </section>
      <section class="panel">
        <h2>美食推荐</h2>
        <ul>${foodHtml || "<li>暂无美食推荐。</li>"}</ul>
      </section>
      <section class="panel">
        <h2>提醒</h2>
        <ul>${warningHtml || "<li>节假日建议提前预约热门景点。</li>"}</ul>
      </section>
      <section class="panel">
        <h2>地图导航</h2>
        <div class="map-links" id="mapLinks"></div>
      </section>
    </aside>
  </main>
  <script>
    const stops = ${stopsJson};
    const container = document.getElementById("mapLinks");
    for (const stop of stops) {
      if (!stop.place) continue;
      const link = document.createElement("a");
      link.href = "https://uri.amap.com/search?keyword=" + encodeURIComponent(stop.place);
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "打开高德：" + stop.place;
      container.appendChild(link);
    }
    if (!container.children.length) {
      container.textContent = "暂无可导航地点。";
    }
  </script>
</body>
</html>`;
}

const server = new McpServer({
  name: "travel-mcp",
  version: "0.1.0",
});

server.tool(
  "amap_weather",
  "查询高德城市天气，支持实时天气或预报。",
  {
    city: z.string().describe("城市名或 adcode，例如：上海、310000"),
    extensions: z.enum(["base", "all"]).default("base").describe("base 为实时天气，all 为天气预报"),
  },
  async ({ city, extensions }) => textResult(await weather(city, extensions))
);

server.tool(
  "amap_poi_search",
  "搜索高德 POI，可查景点、餐厅、酒店等。",
  {
    keywords: z.string().describe("搜索关键词，例如：上海 外滩"),
    city: z.string().optional().describe("城市名或 adcode"),
    types: z.string().optional().describe("高德 POI 类型编码，例如景点 110000、餐饮 050000、酒店 100000"),
    page_size: z.number().int().min(1).max(25).default(10),
  },
  async (input) => textResult(await searchPoi(input))
);

server.tool(
  "amap_route",
  "查询两点之间的步行、驾车或公交路线。origin/destination 可传地址或经纬度。",
  {
    origin: z.string().describe("起点地址或 lng,lat"),
    destination: z.string().describe("终点地址或 lng,lat"),
    city: z.string().optional().describe("公交路线或地址解析需要城市名"),
    mode: z.enum(["walking", "driving", "transit"]).default("walking"),
  },
  async (input) => {
    const data = await route(input);
    return textResult({
      raw: data,
      summary: slimRoute(data, input.mode),
    });
  }
);

server.tool(
  "travel_plan",
  "根据城市、天数、兴趣和预算，结合高德 POI/天气/路线与 DeepSeek 生成完整旅行攻略。",
  {
    destination: z.string().describe("目的地城市，例如：上海"),
    days: z.number().int().min(1).max(10).default(1),
    origin: z.string().optional().describe("出发地，可选"),
    start_date: z.string().optional().describe("出发日期，例如：2026-07-10"),
    travelers: z.string().optional().describe("出行人群，例如：2个成人、亲子、老人同行"),
    interests: z.string().optional().describe("兴趣偏好，例如：历史建筑、美食、亲子、摄影"),
    budget: z.string().optional().describe("预算偏好，例如：经济、适中、高品质"),
    pace: z.string().optional().describe("节奏偏好，例如：轻松、适中、特种兵"),
    transport: z.enum(["walking", "driving", "transit"]).default("transit"),
    include_hotels: z.boolean().default(true),
    forecast: z.boolean().default(true),
  },
  async (input) => textResult(await buildTripPlan(input))
);

server.tool(
  "travel_h5",
  "生成旅行攻略并写入本地 H5 页面，返回文件路径和攻略数据。",
  {
    destination: z.string().describe("目的地城市，例如：上海"),
    days: z.number().int().min(1).max(10).default(1),
    origin: z.string().optional(),
    start_date: z.string().optional(),
    travelers: z.string().optional(),
    interests: z.string().optional(),
    budget: z.string().optional(),
    pace: z.string().optional(),
    transport: z.enum(["walking", "driving", "transit"]).default("transit"),
    include_hotels: z.boolean().default(true),
    forecast: z.boolean().default(true),
    output_path: z.string().optional().describe("输出 HTML 文件路径，默认写入 output/travel-plan.html"),
  },
  async (input) => {
    const result = await buildTripPlan(input);
    const html = createH5(result.plan, result.source_data);
    const outputPath = path.isAbsolute(input.output_path || "")
      ? input.output_path
      : path.resolve(PROJECT_ROOT, input.output_path || "output/travel-plan.html");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, html, "utf8");

    return textResult({
      output_path: outputPath,
      open_hint: `在浏览器打开：${outputPath}`,
      plan: result.plan,
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
