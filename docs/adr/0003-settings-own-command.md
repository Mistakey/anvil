# 设置用 `/anvil set`，不进 Claude Code 的 `/config`

> Source: anvil-k0t (D9)

插件的常规做法是在 manifest 里声明 `userConfig`，设置项会混进 Claude Code 自带的 `/config` 菜单、写进 settings.json。用户不要 anvil 的设置混在全局设置里，所以 anvil 用自己的 `/anvil set` 命令改设置，值存在 anvil 自己的存储（`$.store`）里，本机所有会话共用；自有翻译 API 的 key 放环境变量。不要把这些设置"改回" `userConfig`。
