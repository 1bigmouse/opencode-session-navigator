import { Plugin } from "@opencode/plugin/gui"

const zh = {
  "navigator.label": "会话消息导航",
  "navigator.open": "打开会话消息导航",
  "navigator.jumpFailed": "这条消息已不在当前会话中",
  "navigator.placeholder": "（无文本内容）",
}

export const definition = Plugin.define({
  i18n: {
    en: {
      "navigator.label": "Session message navigator",
      "navigator.open": "Open session message navigator",
      "navigator.jumpFailed": "That message is no longer in this session",
      "navigator.placeholder": "(no text)",
    },
    zh,
    "zh-CN": zh,
    "zh-Hans": zh,
  },
})
