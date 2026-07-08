import "dotenv/config";

const amapKey = process.env.AMAP_KEY;
const deepseekKey = process.env.DEEPSEEK_API_KEY;
const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

if (!amapKey) {
  throw new Error("Missing AMAP_KEY");
}

if (!deepseekKey) {
  throw new Error("Missing DEEPSEEK_API_KEY");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

const weatherUrl = new URL("https://restapi.amap.com/v3/weather/weatherInfo");
weatherUrl.searchParams.set("key", amapKey);
weatherUrl.searchParams.set("city", "上海");
weatherUrl.searchParams.set("extensions", "base");

const weather = await fetchJson(weatherUrl);
if (weather.status !== "1") {
  throw new Error(`Amap smoke test failed: ${weather.info || JSON.stringify(weather)}`);
}

const chat = await fetchJson(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${deepseekKey}`,
  },
  body: JSON.stringify({
    model,
    messages: [
      { role: "system", content: "你只回复 OK。" },
      { role: "user", content: "连通性测试" },
    ],
  }),
});

if (!chat.choices?.[0]?.message?.content) {
  throw new Error(`DeepSeek smoke test failed: ${JSON.stringify(chat)}`);
}

console.log("Amap OK:", weather.lives?.[0]?.city || "上海");
console.log("DeepSeek OK:", chat.choices[0].message.content.trim());

