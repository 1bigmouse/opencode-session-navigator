import { Plugin, Slot, Style } from "@opencode/plugin/gui"
import { definition } from "./definition"
import { Navigator } from "./navigator"
import css from "./navigator.css?inline"

export default Plugin.define({
  ...definition,
  setup(ctx) {
    ctx.add(Style, css)

    ctx.add(Slot, {
      at: "window.bottom",
      order: 100,
      render: () => <Navigator />,
    })
  },
})
