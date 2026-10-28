# dsh-token-flow

DSH 插件：统计各群 / 私聊的 token 消耗与流向。

数据来源是 QQ 桥接写下的 `token-usage.jsonl`（每个回合一行，含 cacheHit / cacheMiss / output / reasoning）。
只读盘，不写任何东西，也不碰会话。

## 安装

```sh
plugin_manager install_bundle <本目录>
```

或放进 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: token-flow
      name: dsh-token-flow
```

## 页面

装好后访问 `<DSH 地址>/dsh-token-flow`：

- 按会话排的表（回合数、未命中、命中、输出、总 token、命中率、均值、占比）
- 两张饼图：总 token 占比、实付（未命中 + 输出）占比
- 各群按天多线图、每日总量折线、未命中按天
- 峰 / 谷拆分、按小时分布、最贵的 10 个回合
- 点某行进入该会话详情；右上角导出 CSV

## 接口

- `/dsh-token-flow/api?days=7`（`days=0` 为全部）
- `/dsh-token-flow/csv?days=7`
- `/dsh-token-flow/detail?days=7&key=group:<群号>`

## 说明

- 群名从 SnowLuma 的群列表现取（缓存 10 分钟），取不到退回磁盘缓存
- 「峰 / 谷」按工作日 09:00–12:00、14:00–18:00 粗分，不查节假日表

## 许可

MIT
