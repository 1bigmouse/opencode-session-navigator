import type { OpenCodeClient, SessionMessageUser } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/gui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import type { definition } from "./definition"

type NavigatorItem = {
  readonly id: string
  readonly text: string
  readonly title: string
  readonly created: number
}

type NavigatorSession = {
  readonly id: string
  readonly server: {
    readonly connected: boolean
    readonly client: OpenCodeClient
  }
}

type PanelLayout = {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly maxHeight: number
  readonly railLimit: number
  readonly visible: boolean
}

const PANEL_WIDTH = 264
const PANEL_GAP = 14
const MIN_ITEMS = 1
const MAX_ITEMS = 1000
const RAIL_MAX = 32
const SCROLL_SELECTOR = '[data-slot="session-timeline-scroll"] [data-scrollable]'

export function Navigator() {
  const ctx = usePlugin<typeof definition>()

  const [items, setItems] = createSignal<NavigatorItem[]>([])
  const [activeID, setActiveID] = createSignal<string>()
  const [seekingID, setSeekingID] = createSignal<string>()
  const [scroller, setScroller] = createSignal<HTMLElement>()
  const [layout, setLayout] = createSignal<PanelLayout>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    maxHeight: 0,
    railLimit: 1,
    visible: false,
  })
  const [hovering, setHovering] = createSignal(false)
  const [focusWithin, setFocusWithin] = createSignal(false)
  const [reload, setReload] = createSignal(0)

  const expanded = () => hovering() || focusWithin()
  const itemIDs = createMemo(() => new Set(items().map((item) => item.id)))
  const railItems = createMemo(() => {
    const all = items()
    if (all.length === 0) return []

    const limit = Math.max(1, Math.min(RAIL_MAX, layout().railLimit))
    const activeIndex = all.findIndex((item) => item.id === activeID())

    if (all.length <= limit) {
      return all.map((item) => ({ id: item.id, active: item.id === activeID() }))
    }

    const indices = new Set<number>()

    if (limit === 1) {
      indices.add(activeIndex >= 0 ? activeIndex : all.length - 1)
    } else {
      for (let index = 0; index < limit; index++) {
        indices.add(Math.round((index * (all.length - 1)) / (limit - 1)))
      }
    }

    if (activeIndex >= 0 && !indices.has(activeIndex)) {
      let nearest = [...indices][0]
      for (const index of indices) {
        if (Math.abs(index - activeIndex) < Math.abs(nearest - activeIndex)) nearest = index
      }
      indices.delete(nearest)
      indices.add(activeIndex)
    }

    return [...indices]
      .sort((a, b) => a - b)
      .map((index) => ({ id: all[index].id, active: index === activeIndex }))
  })

  let loadedKey = ""
  let listRef: HTMLDivElement | undefined
  let railRef: HTMLButtonElement | undefined
  let lastNavInteraction = 0
  let jumpGeneration = 0
  let suppressRailOpen = false

  const markNavInteraction = () => {
    lastNavInteraction = Date.now()
  }

  const updateLayout = () => {
    const element = scroller()

    if (!element || !element.isConnected || ctx.layout.narrow()) {
      setLayout((current) => (current.visible ? { ...current, visible: false } : current))
      return
    }

    const rect = element.getBoundingClientRect()
    const dockRight = rect.right - PANEL_GAP
    const visible =
      rect.width >= 540 &&
      rect.height >= 240 &&
      dockRight <= window.innerWidth - 8 &&
      dockRight - PANEL_WIDTH >= 8

    if (!visible) {
      setLayout((current) => (current.visible ? { ...current, visible: false } : current))
      return
    }

    const maxHeight = Math.max(160, Math.min(540, Math.round(rect.height - 48)))
    const railLimit = Math.max(1, Math.min(RAIL_MAX, Math.floor((rect.height - 80) / 8)))
    const next = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      maxHeight,
      railLimit,
      visible,
    }

    setLayout((current) =>
      current.left === next.left &&
      current.top === next.top &&
      current.width === next.width &&
      current.height === next.height &&
      current.maxHeight === next.maxHeight &&
      current.railLimit === next.railLimit &&
      current.visible === next.visible
        ? current
        : next,
    )
  }

  const measureActive = () => {
    if (seekingID()) return

    const element = scroller()
    if (!element) return

    const maxScroll = element.scrollHeight - element.clientHeight

    // At either end the reader is looking at the first or the latest turn, even
    // when that prompt is taller than the viewport and its row is not mounted.
    if (maxScroll > 1) {
      if (element.scrollTop >= maxScroll - 24) {
        const last = items().at(-1)?.id
        if (last) setActiveID(last)
        return
      }

      if (element.scrollTop <= 24) {
        const first = items()[0]?.id
        if (first) setActiveID(first)
        return
      }
    }

    const box = element.getBoundingClientRect()
    const line = box.top + 100
    const rows: { id: string; top: number; bottom: number }[] = []

    for (const row of element.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const id = row.dataset.messageId
      if (!id) continue

      const rect = row.getBoundingClientRect()
      if (rect.height <= 0 || rect.bottom <= box.top || rect.top >= box.bottom) continue

      rows.push({ id, top: rect.top, bottom: rect.bottom })
    }

    if (rows.length === 0) return

    const hit = rows.find((row) => row.top <= line && row.bottom >= line)
    if (hit) {
      if (hit.id !== activeID()) setActiveID(hit.id)
      return
    }

    const near = rows
      .slice()
      .sort((a, b) => {
        const distance = Math.abs(a.top - line) - Math.abs(b.top - line)
        return distance === 0 ? a.top - b.top : distance
      })[0]

    if (near && near.id !== activeID()) setActiveID(near.id)
  }

  // The session's messages. Reloads on a session switch, when the server comes
  // back, and when the timeline mounts a prompt that is not in the list yet.
  createEffect(() => {
    const session = ctx.sessions.current()
    const tick = reload()

    if (!session) {
      loadedKey = ""
      setItems([])
      setActiveID(undefined)
      return
    }

    if (loadedKey !== session.key) {
      loadedKey = session.key
      setItems([])
      setActiveID(undefined)
    }

    if (session.pending || !session.server.connected) return

    void tick
    const controller = new AbortController()

    onCleanup(() => controller.abort())

    void loadNavigatorItems(session, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return

        setItems(next)
        setActiveID((current) => (current && next.some((item) => item.id === current) ? current : next.at(-1)?.id))
        queueMicrotask(() => {
          updateLayout()
          measureActive()
        })
      })
      .catch(() => {
        // Keep whatever is on screen. The next reload or session switch retries.
      })
  })

  // The timeline's scroll element for the routed session. Cached timelines stay
  // mounted, so only a visible scroller belongs to the session on screen.
  createEffect(() => {
    const session = ctx.sessions.current()

    if (!session) {
      setScroller(undefined)
      return
    }

    let disposed = false
    let bound: HTMLElement | undefined
    let frame = 0
    let interval: ReturnType<typeof setInterval> | undefined
    let unknownTimer: ReturnType<typeof setTimeout> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let resizeObserver: ResizeObserver | undefined
    let intersectionObserver: IntersectionObserver | undefined
    let mutationObserver: MutationObserver | undefined
    let scrollHandler: (() => void) | undefined

    const scheduleMeasure = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!disposed) measureActive()
      })
    }

    const checkUnknown = () => {
      if (!bound || disposed) return

      const known = itemIDs()
      const oldest = items()[0]?.id
      const rows = bound.querySelectorAll<HTMLElement>('[data-timeline-row="UserMessage"][data-message-id]')
      let unknown = false

      for (const row of rows) {
        const id = row.dataset.messageId
        if (!id) continue
        // Prompts older than the capped list still render while scrolling.
        if (oldest && id < oldest) continue
        if (!known.has(id)) {
          unknown = true
          break
        }
      }

      if (!unknown || unknownTimer || retryTimer) return

      unknownTimer = setTimeout(() => {
        unknownTimer = undefined
        if (disposed) return
        setReload((value) => value + 1)

        // A prompt can appear in the DOM a moment before its message lands on the
        // server. Check once more after the first fetch settles.
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          if (disposed) return

          const latest = bound?.querySelectorAll<HTMLElement>('[data-timeline-row="UserMessage"][data-message-id]')
          if (!latest) return

          for (const row of latest) {
            const id = row.dataset.messageId
            if (id && !itemIDs().has(id)) {
              setReload((value) => value + 1)
              return
            }
          }
        }, 1600)
      }, 350)
    }

    const teardown = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      resizeObserver?.disconnect()
      intersectionObserver?.disconnect()
      mutationObserver?.disconnect()
      resizeObserver = undefined
      intersectionObserver = undefined
      mutationObserver = undefined
      if (scrollHandler && bound) bound.removeEventListener("scroll", scrollHandler)
      scrollHandler = undefined
      if (unknownTimer) clearTimeout(unknownTimer)
      if (retryTimer) clearTimeout(retryTimer)
      unknownTimer = undefined
      retryTimer = undefined
      if (bound) bound.removeAttribute("data-ocn-seeking")
      bound = undefined
      setScroller(undefined)
    }

    const bind = (element: HTMLElement) => {
      teardown()
      if (disposed) return

      bound = element
      setScroller(element)

      scrollHandler = () => scheduleMeasure()
      element.addEventListener("scroll", scrollHandler, { passive: true })

      resizeObserver = new ResizeObserver(() => {
        updateLayout()
        scheduleMeasure()
      })
      resizeObserver.observe(element)

      intersectionObserver = new IntersectionObserver(() => updateLayout(), { threshold: [0, 0.01] })
      intersectionObserver.observe(element)

      mutationObserver = new MutationObserver((records) => {
        scheduleMeasure()
        if (records.some(recordsHaveUserRow)) checkUnknown()
      })
      mutationObserver.observe(element, { childList: true, subtree: true })

      updateLayout()
      scheduleMeasure()
      checkUnknown()
    }

    const locate = () => {
      if (disposed) return false

      const found = findVisibleScroller()
      if (!found) return false
      if (found !== bound) bind(found)
      return true
    }

    locate()

    interval = setInterval(() => {
      if (disposed) return

      if (!bound || !bound.isConnected || !isVisible(bound)) {
        teardown()
        locate()
        return
      }

      const found = findVisibleScroller()
      if (found && found !== bound) {
        bind(found)
        return
      }

      updateLayout()
    }, 1200)

    const onResize = () => updateLayout()
    window.addEventListener("resize", onResize)

    onCleanup(() => {
      disposed = true
      window.removeEventListener("resize", onResize)
      if (interval) clearInterval(interval)
      interval = undefined
      teardown()
    })
  })

  // Keep the card beside the timeline as the conversation, side panel, or
  // window changes size.
  createEffect(() => {
    scroller()
    items().length
    ctx.layout.narrow()
    updateLayout()
  })

  // Follow the prompt in view, unless the reader is browsing the navigator.
  createEffect(() => {
    const id = activeID()

    if (!id || !expanded() || seekingID()) return
    if (!layout().visible || items().length === 0) return
    if (Date.now() - lastNavInteraction < 1200) return

    const list = listRef
    if (!list) return

    const row = list.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(id)}"]`)
    if (!row) return

    const listRect = list.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const padding = 10

    if (rowRect.top < listRect.top + padding) {
      list.scrollTop -= listRect.top + padding - rowRect.top
    } else if (rowRect.bottom > listRect.bottom - padding) {
      list.scrollTop += rowRect.bottom - (listRect.bottom - padding)
    }
  })

  onMount(() => {
    updateLayout()
  })

  const jumpTo = async (item: NavigatorItem) => {
    const element = scroller()
    if (!element) return

    const token = ++jumpGeneration
    setActiveID(item.id)
    setSeekingID(item.id)
    detachFollow(element)

    const row = findRow(element, item.id)

    try {
      if (row) {
        const box = element.getBoundingClientRect()
        const rect = row.getBoundingClientRect()
        const visible = rect.bottom > box.top && rect.top < box.bottom
        const distance =
          rect.top < box.top ? box.top - rect.top : rect.top > box.bottom ? rect.top - box.bottom : 0
        const smooth = !reducedMotion() && (visible || distance < element.clientHeight * 1.4)

        scrollToRow(element, row, smooth ? "smooth" : "auto")
        await (smooth ? waitForScrollEnd(element, 520) : afterRender())
      } else {
        element.setAttribute("data-ocn-seeking", "true")
        const found = await seekMessage({
          scroller: element,
          targetID: item.id,
          items: items(),
          cancelled: () => token !== jumpGeneration || !element.isConnected,
        })

        if (found && token === jumpGeneration) {
          await settleRow(element, item.id, () => token !== jumpGeneration)
        }

        if (!found && token === jumpGeneration) {
          ctx.toast.show({ title: ctx.t("navigator.jumpFailed"), variant: "error" })
        }
      }
    } finally {
      if (token === jumpGeneration) {
        element.removeAttribute("data-ocn-seeking")
        setSeekingID(undefined)
        measureActive()

        // A row that streams below the target can measure a moment later and
        // shift the scroll again. Hold the prompt in place while that settles.
        void settleVisible(element, item.id, () => token !== jumpGeneration)
      }
    }
  }

  const focusActiveRow = () => {
    requestAnimationFrame(() => {
      const list = listRef
      const row =
        list?.querySelector<HTMLElement>(".ocn-row-active") ?? list?.querySelector<HTMLElement>(".ocn-row")
      row?.focus()
    })
  }

  const openFromRail = () => {
    if (suppressRailOpen) return
    if (railRef && !railRef.matches(":focus-visible")) return
    setFocusWithin(true)
    focusActiveRow()
  }

  const onDockFocusIn = (event: FocusEvent) => {
    const target = event.target
    if (target instanceof HTMLElement && target.matches(":focus-visible")) setFocusWithin(true)
  }

  const onDockFocusOut = (event: FocusEvent) => {
    const current = event.currentTarget as HTMLElement | null
    const next = event.relatedTarget

    if (!current || !(next instanceof Node) || !current.contains(next)) {
      setFocusWithin(false)
    }
  }

  const onNavKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return

    event.preventDefault()
    suppressRailOpen = true
    setFocusWithin(false)
    setHovering(false)
    requestAnimationFrame(() => {
      railRef?.focus()
      suppressRailOpen = false
    })
  }

  const onListKeyDown = (event: KeyboardEvent) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return

    const row = target.closest<HTMLElement>("[data-nav-id]")
    if (!row) return

    const current = items().findIndex((item) => item.id === row.dataset.navId)
    if (current < 0) return

    let next = current

    if (event.key === "ArrowDown") next = Math.min(items().length - 1, current + 1)
    else if (event.key === "ArrowUp") next = Math.max(0, current - 1)
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = items().length - 1
    else return

    event.preventDefault()

    const item = items()[next]
    if (!item) return

    markNavInteraction()
    const nextRow = listRef?.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(item.id)}"]`)
    nextRow?.focus()
    void jumpTo(item)
  }

  return (
    <Show when={layout().visible && items().length >= MIN_ITEMS}>
      <Portal mount={document.body}>
        <div
          class="ocn-anchor"
          style={{
            left: `${layout().left}px`,
            top: `${layout().top}px`,
            width: `${layout().width}px`,
            height: `${layout().height}px`,
          }}
        >
          <div
            class="ocn-dock"
            onPointerEnter={() => setHovering(true)}
            onPointerLeave={() => setHovering(false)}
            onFocusIn={onDockFocusIn}
            onFocusOut={onDockFocusOut}
          >
            <Show
              when={expanded()}
              fallback={
                <button
                  ref={railRef}
                  type="button"
                  class="ocn-rail"
                  title={ctx.t("navigator.open")}
                  aria-label={ctx.t("navigator.open")}
                  onFocus={openFromRail}
                  onClick={openFromRail}
                >
                  <For each={railItems()}>
                    {(marker) => (
                      <span class="ocn-rail-mark" classList={{ "ocn-rail-mark-active": marker.active }} />
                    )}
                  </For>
                </button>
              }
            >
              <div class="ocn-panel-wrap">
                <nav
                  class="ocn-panel"
                  aria-label={ctx.t("navigator.label")}
                  style={{ "max-height": `${layout().maxHeight}px` }}
                  onKeyDown={onNavKeyDown}
                  onPointerDown={markNavInteraction}
                >
                  <div class="ocn-list" ref={listRef} onKeyDown={onListKeyDown} onWheel={markNavInteraction}>
                    <For each={items()}>
                      {(item, index) => {
                        const active = () => activeID() === item.id
                        const tabStop = () => {
                          const current = activeID()
                          if (current) return current === item.id
                          return index() === 0
                        }

                        return (
                          <button
                            type="button"
                            class="ocn-row"
                            classList={{
                              "ocn-row-active": active(),
                              "ocn-row-seeking": seekingID() === item.id,
                            }}
                            data-nav-id={item.id}
                            aria-current={active() ? "true" : undefined}
                            tabIndex={tabStop() ? 0 : -1}
                            title={item.title || ctx.t("navigator.placeholder")}
                            onClick={() => {
                              markNavInteraction()
                              void jumpTo(item)
                            }}
                          >
                            <span class="ocn-row-text">{item.text || ctx.t("navigator.placeholder")}</span>
                            <span class="ocn-row-mark" aria-hidden="true" />
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </nav>
              </div>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

async function loadNavigatorItems(session: NavigatorSession, signal: AbortSignal): Promise<NavigatorItem[]> {
  const client = session.server.client
  let revertID: string | undefined

  try {
    const info = await client.session.get({ sessionID: session.id }, { signal })
    revertID = info.revert?.messageID
  } catch {
    // The message list can still load without the session metadata.
  }

  const collected: NavigatorItem[] = []
  let cursor: string | undefined

  for (let page = 0; page < 12; page++) {
    // The API forbids combining `order` with `cursor`. Pages are newest first;
    // the collected list is sorted after the last page.
    const query: { sessionID: string; type: "user"; limit: number; cursor?: string } = {
      sessionID: session.id,
      type: "user",
      limit: 200,
    }
    if (cursor) query.cursor = cursor

    const result = await client.message.list(query, { signal })

    for (const message of result.data) {
      if (message.type !== "user") continue
      if (revertID && message.id >= revertID) continue

      const text = promptText(message)
      collected.push({
        id: message.id,
        text: text.slice(0, 400),
        title: text.slice(0, 2000),
        created: message.time.created,
      })
    }

    const next = result.cursor.next
    if (!next || next === cursor) break
    cursor = next
  }

  collected.sort((a, b) => (a.created === b.created ? a.id.localeCompare(b.id) : a.created - b.created))

  const seen = new Set<string>()
  const unique: NavigatorItem[] = []

  for (const item of collected) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    unique.push(item)
  }

  return unique.length > MAX_ITEMS ? unique.slice(-MAX_ITEMS) : unique
}

function promptText(message: SessionMessageUser): string {
  const display = readDisplayText(message.metadata)
  const parts: string[] = []

  if (display) parts.push(display)
  else if (message.text) parts.push(message.text)

  if (message.files?.length) {
    for (const file of message.files) {
      const name = file.name ?? file.description
      if (name) parts.push(name)
    }
  }

  if (message.agents?.length) {
    for (const agent of message.agents) parts.push(`@${agent.name}`)
  }

  if (message.skills?.length) {
    for (const skill of message.skills) parts.push(skill.name)
  }

  return parts.join(" · ").replace(/\s+/g, " ").trim()
}

function readDisplayText(metadata: SessionMessageUser["metadata"]): string | undefined {
  const value = metadata?.displayText
  return typeof value === "string" && value.trim() ? value : undefined
}

function findVisibleScroller(): HTMLElement | undefined {
  const candidates = [...document.querySelectorAll<HTMLElement>(SCROLL_SELECTOR)].filter(isVisible)
  if (candidates.length <= 1) return candidates[0]

  const centerX = window.innerWidth / 2
  const centerY = window.innerHeight / 2

  return candidates
    .map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        element,
        distance: Math.abs((rect.left + rect.right) / 2 - centerX) + Math.abs((rect.top + rect.bottom) / 2 - centerY),
      }
    })
    .sort((a, b) => a.distance - b.distance)[0]?.element
}

function recordsHaveUserRow(record: MutationRecord): boolean {
  const hasRow = (node: Node): boolean => {
    if (!(node instanceof Element)) return false
    if (node.matches('[data-timeline-row="UserMessage"]')) return true
    return !!node.querySelector('[data-timeline-row="UserMessage"]')
  }

  for (const node of record.addedNodes) if (hasRow(node)) return true
  for (const node of record.removedNodes) if (hasRow(node)) return true
  return false
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected) return false

  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return false

  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0" ||
      style.getPropertyValue("content-visibility") === "hidden"
    ) {
      return false
    }
  }

  return true
}

function findRow(scroller: HTMLElement, id: string): HTMLElement | undefined {
  const anchored = document.getElementById(`message-${id}`)
  if (anchored && scroller.contains(anchored)) return anchored

  for (const row of scroller.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (row.dataset.messageId === id) return row
  }

  return undefined
}

function stickyInset(scroller: HTMLElement): number {
  return scroller.querySelector<HTMLElement>("[data-session-title]")?.offsetHeight ?? 0
}

// Measuring the rows around the target shifts the scroll position by a frame or
// two later. Stay hidden and keep re-aligning until the row holds its place.
async function settleRow(scroller: HTMLElement, id: string, cancelled: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 80 : 120))
    if (cancelled()) return false

    const row = findRow(scroller, id)
    if (!row) continue

    const box = scroller.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    const inset = stickyInset(scroller)
    const delta = rect.top - (box.top + inset)

    if (Math.abs(delta) <= 2) return true
    scroller.scrollTop += delta
  }

  return false
}

async function settleVisible(scroller: HTMLElement, id: string, cancelled: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 140))
    if (cancelled()) return

    const row = findRow(scroller, id)
    if (!row) return

    const box = scroller.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    const inset = stickyInset(scroller)
    const delta = rect.top - (box.top + inset)

    if (Math.abs(delta) <= 3) return
    scroller.scrollTop += delta
  }
}

function scrollToRow(scroller: HTMLElement, row: HTMLElement, behavior: ScrollBehavior) {
  const top =
    row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - stickyInset(scroller)

  scroller.scrollTo({ top: Math.max(0, top), behavior })
}

// The app keeps following the newest content when it detaches programmatically.
// An upward wheel intent is its own signal for "the reader moved away".
function detachFollow(scroller: HTMLElement) {
  try {
    scroller.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true, composed: true }),
    )
  } catch {
    // Older Electron builds can refuse the constructor; scrolling still works.
  }
}

async function seekMessage(input: {
  scroller: HTMLElement
  targetID: string
  items: readonly NavigatorItem[]
  cancelled: () => boolean
}): Promise<HTMLElement | undefined> {
  const { scroller, targetID, items, cancelled } = input
  const indexByID = new Map(items.map((item, index) => [item.id, index]))
  const targetIndex = indexByID.get(targetID)

  if (targetIndex === undefined) return undefined

  let low = 0
  let high = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  let lastTop = Number.NaN
  let stalled = 0

  for (let attempt = 0; attempt < 28; attempt++) {
    if (cancelled()) return undefined

    const mounted = findRow(scroller, targetID)
    if (mounted) {
      const box = scroller.getBoundingClientRect()
      const rect = mounted.getBoundingClientRect()
      const inset = stickyInset(scroller)
      const visible = rect.bottom > box.top + inset && rect.top < box.bottom
      const desired = Math.max(
        0,
        rect.top - box.top + scroller.scrollTop - inset,
      )

      if (visible && Math.abs(desired - scroller.scrollTop) <= 2) return mounted

      scroller.scrollTop = desired
      await afterRender()
      continue
    }

    high = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    if (low > high) low = 0
    const samples = readSamples(scroller, indexByID)

    if (samples.length > 0) {
      const first = samples[0]
      const last = samples[samples.length - 1]

      if (last.index < targetIndex) low = Math.max(low, scroller.scrollTop + 1)
      else if (first.index > targetIndex) high = Math.min(high, scroller.scrollTop - 1)
    }

    let next = estimateTop(samples, targetIndex, items.length, high)
    next = Math.max(low, Math.min(high, next))

    if (!Number.isFinite(next)) break

    if (Math.abs(next - scroller.scrollTop) < 2) {
      const direction =
        samples.length > 0 && samples[samples.length - 1].index < targetIndex
          ? 1
          : samples.length > 0 && samples[0].index > targetIndex
            ? -1
            : 0

      if (direction === 0) break

      next = Math.max(low, Math.min(high, scroller.scrollTop + direction * Math.max(80, scroller.clientHeight * 0.75)))
    }

    if (Math.abs(next - lastTop) < 1) {
      stalled += 1
      if (stalled >= 3) break
    } else {
      stalled = 0
    }

    lastTop = next
    scroller.scrollTop = next

    await afterRender()
  }

  return findRow(scroller, targetID)
}

type Sample = {
  readonly index: number
  readonly top: number
}

function readSamples(scroller: HTMLElement, indexByID: ReadonlyMap<string, number>): Sample[] {
  const box = scroller.getBoundingClientRect()
  const scrollTop = scroller.scrollTop
  const seen = new Map<number, Sample>()

  for (const row of scroller.querySelectorAll<HTMLElement>('[data-timeline-row="UserMessage"][data-message-id]')) {
    const id = row.dataset.messageId
    if (!id) continue

    const index = indexByID.get(id)
    if (index === undefined || seen.has(index)) continue

    const rect = row.getBoundingClientRect()
    seen.set(index, { index, top: rect.top - box.top + scrollTop })
  }

  return [...seen.values()].sort((a, b) => a.index - b.index)
}

function estimateTop(samples: readonly Sample[], targetIndex: number, count: number, maxScroll: number): number {
  if (maxScroll <= 0) return 0

  const average = maxScroll / Math.max(1, count - 1)

  if (samples.length === 0) return (targetIndex / Math.max(1, count - 1)) * maxScroll

  let before: Sample | undefined
  let after: Sample | undefined

  for (const sample of samples) {
    if (sample.index <= targetIndex) before = sample
    if (sample.index >= targetIndex) {
      after = sample
      break
    }
  }

  if (before && after && before.index !== after.index) {
    const progress = (targetIndex - before.index) / (after.index - before.index)
    return before.top + (after.top - before.top) * progress
  }

  if (before) {
    const previous = samples[samples.indexOf(before) - 1]
    const slope = previous
      ? Math.max(1, (before.top - previous.top) / (before.index - previous.index))
      : Math.max(1, average)
    return before.top + (targetIndex - before.index) * slope
  }

  if (after) {
    const next = samples[samples.indexOf(after) + 1]
    const slope = next ? Math.max(1, (next.top - after.top) / (next.index - after.index)) : Math.max(1, average)
    return after.top - (after.index - targetIndex) * slope
  }

  return (targetIndex / Math.max(1, count - 1)) * maxScroll
}

function afterRender(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

function waitForScrollEnd(element: HTMLElement, timeout: number): Promise<void> {
  return new Promise((resolve) => {
    let finished = false

    const finish = () => {
      if (finished) return
      finished = true
      element.removeEventListener("scrollend", finish)
      clearTimeout(timer)
      resolve()
    }

    const timer = setTimeout(finish, timeout)
    element.addEventListener("scrollend", finish, { once: true })
  })
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
}
