# 设置放在 `/config`（userConfig），不用 `$.store`

> Source: anvil-k0t (D9)

mods 文档把 `$.store` 列为存设置的地方，但它连续 `cleanupPeriodDays`（默认 30 天）没有会话读写就会被清掉；用户在多台电脑上用，某台久不开 Claude Code，设置会悄悄回到默认。所以 anvil 的设置（v1 六项，anvil-7ds 加了面板、翻译框的显示开关）都用插件清单的 `userConfig` 声明，出现在 `/config` 里、存进 settings.json，和 flightdeck 等有设置的 mod 一样；代价是这些设置混在 Claude Code 自己的设置列表里。曾考虑过自做 `/anvil set` 命令加 `$.store`，因为上面的清理规则放弃。自有翻译 API 的 key 放环境变量，不进设置。
