# Travel MCP

一个本地 MCP Server，把高德地图 Web 服务和 DeepSeek 封装成旅行规划工具。

## 功能

- 查询城市天气
- 搜索景点、餐厅、酒店、商圈等 POI
- 查询步行、驾车、公交路线
- 用 DeepSeek 生成可执行旅行攻略
- 生成可直接打开的 H5 行程页

## 启动

```powershell
npm install
npm start
```

## MCP 客户端配置

把下面配置加入支持 MCP 的客户端：

```json
{
  "mcpServers": {
    "travel-mcp": {
      "command": "node",
      "args": ["E:\\mywork\\xadxyy\\travel\\src\\server.js"],
      "env": {
        "AMAP_KEY": "你的高德 Web 服务 Key",
        "DEEPSEEK_API_KEY": "你的 DeepSeek Key",
        "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
        "DEEPSEEK_MODEL": "deepseek-chat"
      }
    }
  }
}
```

如果客户端会从工作目录读取 `.env`，也可以只保留 `command` 和 `args`。

## 暴露的 MCP 工具

- `amap_weather`：查询城市天气
- `amap_poi_search`：搜索 POI
- `amap_route`：查询路线
- `travel_plan`：生成旅行攻略
- `travel_h5`：生成本地 H5 行程页

