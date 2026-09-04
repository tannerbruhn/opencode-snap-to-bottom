// Claude Code-style "snap to bottom" for the opencode session transcript.
//
// In Claude Code the transcript IS the terminal's scrollback, so its scroll
// rules are really the terminal emulator's: any keystroke jumps you back to
// the bottom, new output does not, and the scrollback keys never reach the
// app. opencode owns a scrollbox instead, so each of those has to be
// re-implemented. It already pins during streaming and after submit; this
// plugin adds the keystroke rule.
//
// Options (tui.json -> ["opencode-snap-to-bottom", { ... }]):
//   trigger  "any-key" (default) every keystroke except the scroll commands,
//                                the way a terminal treats scrollback
//            "typing"            only characters actually landing in the prompt
//   paste    snap when pasting into the prompt            (default true)

const DEFAULTS = {
  trigger: "any-key",
  paste: true,
}

// opencode's own scroll and message-navigation commands. These move the
// viewport on purpose, so snapping afterwards would undo what was just asked
// for. A terminal gets this for free -- shift+PageUp and the wheel are
// swallowed by the emulator and never reach the program.
const SCROLL_COMMANDS = new Set([
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
  "session.first",
  "session.last",
  "session.message.next",
  "session.message.previous",
  "session.messages_last_user",
])

// Modes where a keystroke belongs to a dialog or question form rather than to
// the transcript view. Everything else ("base", the @-file/slash "autocomplete"
// popup, and any mode added later) counts.
const BLOCKED_MODES = new Set(["modal", "question"])

const MODIFIER_KEYS = new Set(["shift", "ctrl", "alt", "meta", "super", "hyper", "capslock", "numlock"])

function isRealKeypress(key) {
  if (!key) return false
  if (key.eventType === "release") return false
  // Kitty keyboard protocol reports bare modifier presses; a terminal would
  // not scroll for those.
  return !MODIFIER_KEYS.has(key.name)
}

function isTextInput(key) {
  if (!isRealKeypress(key)) return false
  if (key.ctrl || key.meta || key.super || key.hyper) return false
  if (key.name === "backspace" || key.name === "delete") return true
  const seq = typeof key.sequence === "string" ? key.sequence : ""
  const chars = Array.from(seq)
  // More than one code point means an escape sequence or an alt-prefixed
  // combo, not a character landing in the prompt.
  if (chars.length !== 1) return false
  const cp = chars[0].codePointAt(0)
  return cp >= 0x20 && cp !== 0x7f
}

// The transcript is the only scrollbox in the TUI that asks to stick to the
// bottom, so stickyStart is the safest way to pick it out of the render tree
// -- the sidebar, dialogs, autocomplete and the diff viewer have scrollboxes
// too, and none of them are sticky.
function isTranscript(node) {
  return (
    typeof node.scrollTo === "function" &&
    typeof node.scrollHeight === "number" &&
    node.stickyScroll === true &&
    node.stickyStart === "bottom"
  )
}

function findTranscript(node) {
  if (!node || node.isDestroyed) return
  if (isTranscript(node)) return node
  // Never descend into a scrollbox: its children are the transcript's
  // message renderables, and no scrollbox nests a sticky one.
  if (typeof node.scrollTo === "function") return
  const children = typeof node.getChildren === "function" ? node.getChildren() : []
  for (const child of children) {
    const hit = findTranscript(child)
    if (hit) return hit
  }
}

export default {
  id: "opencode-snap-to-bottom",
  tui: async (api, options) => {
    const config = { ...DEFAULTS, ...(options ?? {}) }

    let cached
    function transcript() {
      if (cached && !cached.isDestroyed) return cached
      cached = findTranscript(api.renderer.root)
      return cached
    }

    function snap() {
      const box = transcript()
      if (!box) return
      const max = Math.max(0, box.scrollHeight - box.viewport.height)
      // Already pinned: leave it alone so sticky scroll keeps following.
      if (box.scrollTop >= max) return
      // Landing exactly on the bottom re-engages opencode's sticky scroll,
      // so output keeps following again until the next manual scroll.
      box.scrollTo(max)
    }

    function active() {
      if (api.route.current.name !== "session") return false
      if (api.ui.dialog.open) return false
      return !BLOCKED_MODES.has(api.mode.current())
    }

    // Typing can grow the prompt and shrink the viewport, so let the keystroke
    // finish landing before measuring.
    function schedule() {
      queueMicrotask(snap)
    }

    // Which command, if any, claimed the current keystroke. Recorded between
    // the "key" and "key:after" intercepts so the handler can tell a scroll
    // command apart from every other binding.
    let claimed
    const offBefore = api.keymap.intercept("key", () => {
      claimed = undefined
    })
    const offDispatch = api.keymap.on("dispatch", (evt) => {
      if (evt.phase !== "binding-execute") return
      const cmd = typeof evt.command === "string" ? evt.command : evt.binding?.cmd
      if (typeof cmd === "string") claimed = cmd
    })

    const offKey = api.keymap.intercept("key:after", (ctx) => {
      if (!active()) return
      if (config.trigger === "any-key") {
        if (!isRealKeypress(ctx.event)) return
        // A scroll command just ran (or is mid leader-sequence): honour it.
        if (claimed && SCROLL_COMMANDS.has(claimed)) return
        if (ctx.reason === "sequence-pending") return
      } else {
        // handled means some binding claimed the key, scroll included.
        if (ctx.handled) return
        if (!isTextInput(ctx.event)) return
      }
      schedule()
    })

    api.lifecycle.onDispose(offBefore)
    api.lifecycle.onDispose(offDispatch)
    api.lifecycle.onDispose(offKey)

    if (config.paste) {
      const onPaste = () => {
        if (!active()) return
        schedule()
      }
      api.renderer.keyInput.on("paste", onPaste)
      api.lifecycle.onDispose(() => api.renderer.keyInput.off("paste", onPaste))
    }
  },
}
