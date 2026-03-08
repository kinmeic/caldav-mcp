# CalDAV MCP

通过MCP协议操作群晖日历的Node.js服务。

## 快速开始

1. 安装依赖：
```bash
npm install
```

2. 复制并配置环境变量：
```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的群晖信息：

```
CALDAV_URL=http://127.0.0.1:5000/caldav/
CALDAV_USERNAME=你的用户名
CALDAV_PASSWORD=你的密码
```

3. 启动服务：
```bash
npm start
```

## 可用工具

### 日历

| 工具名 | 描述 |
|--------|------|
| `list_calendars` | 列出所有日历 |

### 事件 (VEVENT)

| 工具名 | 描述 | 必需参数 |
|--------|------|----------|
| `list_events` | 查询指定日期范围内的事件 | `calendar_id`, `start_date`, `end_date` |
| `get_event` | 获取单个事件详情 | `calendar_id`, `event_id` |
| `create_event` | 创建新事件 | `calendar_id`, `title`, `start_date`, `end_date` |
| `update_event` | 更新事件 | `calendar_id`, `event_id` |
| `delete_event` | 删除事件 | `calendar_id`, `event_id` |

### 任务 (VTODO)

| 工具名 | 描述 | 必需参数 |
|--------|------|----------|
| `list_todos` | 列出所有任务 | `calendar_id` |
| `get_todo` | 获取单个任务详情 | `calendar_id`, `todo_id` |
| `create_todo` | 创建新任务 | `calendar_id`, `title` |
| `update_todo` | 更新任务 | `calendar_id`, `todo_id` |
| `delete_todo` | 删除任务 | `calendar_id`, `todo_id` |

### 参数说明

- `calendar_id`: 日历 URL，从 `list_calendars` 获取
- `event_id` / `todo_id`: 事件/任务的唯一标识 UID
- `start_date` / `end_date` / `due_date`: ISO 格式日期，如 `2024-01-15T10:00:00`
- `title`: 标题
- `description`: 描述（可选）
- `location`: 地点（可选）
- `priority`: 优先级 1(高) / 5(中) / 9(低) / 0(无)
- `status`: 状态 NEEDS-ACTION / IN-PROCESS / COMPLETED / CANCELLED
- `rrule`: 重复规则，如 `FREQ=WEEKLY;BYDAY=MO,WE,FR`

### 高级功能

| 工具名 | 描述 | 必需参数 |
|--------|------|----------|
| `find_free_busy` | 查询空闲时段 | `calendar_id`, `start_date`, `end_date` |
| `check_conflict` | 检测时间冲突 | `calendar_id`, `start_date`, `end_date` |
| `search_events` | 搜索事件 | `calendar_id`, `query` |
| `create_recurring_event` | 创建重复日程 | `calendar_id`, `title`, `start_date`, `end_date`, `rrule` |

### RRULE 示例

- 每周一、三、五: `FREQ=WEEKLY;BYDAY=MO,WE,FR`
- 每天重复10次: `FREQ=DAILY;COUNT=10`
- 每月第一个周五: `FREQ=MONTHLY;BYDAY=1FR`
- 每周一至周五: `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`

## 在Claude Code中使用

配置MCP服务器路径到你的配置文件：

```json
{
  "mcpServers": {
    "caldav": {
      "command": "node",
      "args": ["/path/to/caldav-mcp/src/index.js"],
      "env": {
        "CALDAV_URL": "http://127.0.0.1:5000/caldav/",
        "CALDAV_USERNAME": "your_username",
        "CALDAV_PASSWORD": "your_password"
      }
    }
  }
}
```
