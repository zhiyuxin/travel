import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "travel-mcp-smoke",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: "node",
  args: ["src/server.js"],
  env: process.env,
});

await client.connect(transport);

const tools = await client.listTools();
const names = tools.tools.map((tool) => tool.name);
const required = ["amap_weather", "amap_poi_search", "amap_route", "travel_plan", "travel_h5"];
for (const name of required) {
  if (!names.includes(name)) {
    throw new Error(`Missing MCP tool: ${name}`);
  }
}

const result = await client.callTool({
  name: "amap_weather",
  arguments: {
    city: "上海",
    extensions: "base",
  },
});

console.log("MCP tools:", names.join(", "));
console.log("MCP weather sample:", result.content?.[0]?.text?.slice(0, 180));

await client.close();

