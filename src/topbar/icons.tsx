import type { JSX } from "solid-js"
import type { RowKind } from "./types"

type IconProps = { size?: number }

function Glyph(props: IconProps & { children: JSX.Element }) {
  return (
    <svg
      width={props.size ?? 18}
      height={props.size ?? 18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  )
}

const PAGE = "M14.4 3H7.6A2.6 2.6 0 0 0 5 5.6v12.8A2.6 2.6 0 0 0 7.6 21h9.8a2.6 2.6 0 0 0 2.6-2.6V8L14.4 3Z"
const FOLD = "M14.2 3.2v4.1a1.7 1.7 0 0 0 1.7 1.7h4.1"

export const IconRead = (p: IconProps) => (
  <Glyph {...p}>
    <path d={PAGE} />
    <path d={FOLD} />
    <circle cx="10.4" cy="14.5" r="2.6" />
    <path d="M12.3 16.4 13.7 17.8" />
  </Glyph>
)

export const IconSearch = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="10.6" cy="10.6" r="6.9" />
    <path d="M15.7 15.7 20.5 20.5" />
  </Glyph>
)

export const IconEdit = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M14.4 3H7.6A2.6 2.6 0 0 0 5 5.6v6.8" />
    <path d="M14.4 3 20 8.6v9.8a2.6 2.6 0 0 1-2.6 2.6h-6" />
    <path d={FOLD} />
    <path
      d="M6.7 21.2 7.8 17.4l7.8-7.8a2.1 2.1 0 0 1 2.8 2.8l-7.8 7.8-3.9 1Z"
      fill="#181818"
    />
    <path d="M7.8 17.4l2.8 2.8" />
  </Glyph>
)

export const IconWrite = (p: IconProps) => (
  <Glyph {...p}>
    <path d={PAGE} />
    <path d={FOLD} />
    <path d="M9.8 12.2v6.2M6.7 15.3h6.2" />
  </Glyph>
)

export const IconUpdate = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3.4" y="8.2" width="11" height="12.2" rx="2.4" />
    <path
      d="M15 3.4H8.6A2.6 2.6 0 0 0 6 6v11.1a2.6 2.6 0 0 0 2.6 2.6H17a2.6 2.6 0 0 0 2.6-2.6V7.8L15 3.4Z"
      fill="#181818"
    />
    <path d="M14.8 3.6v4.1a1.7 1.7 0 0 0 1.7 1.7h4.1" />
  </Glyph>
)

export const IconTest = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M9.4 3h5.2" />
    <path d="M10.3 3v5.4L5.8 18.1A2.1 2.1 0 0 0 7.7 21h8.6a2.1 2.1 0 0 0 1.9-2.9l-4.5-9.7V3" />
    <path d="M7.4 15.3h9.2" />
  </Glyph>
)

export const IconBash = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="2.6" y="4" width="18.8" height="16" rx="3.2" />
    <path d="M2.6 8h18.8" />
    <path d="M6.4 11.6 8.6 13.8 6.4 16" />
    <path d="M11.4 16h4.2" />
  </Glyph>
)

export const IconTask = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="6.5" cy="6" r="2.3" />
    <circle cx="6.5" cy="18" r="2.3" />
    <circle cx="17.5" cy="7" r="2.3" />
    <path d="M6.5 8.3v7.4" />
    <path d="M17.5 9.3v1.3a3.7 3.7 0 0 1-3.7 3.7H6.5" />
  </Glyph>
)

export const IconTodo = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="3.2" />
    <path d="M6.8 8.3l1.1 1.1 2.1-2.1" />
    <path d="M12.4 8.4h4.7" />
    <path d="M6.8 13.3l1.1 1.1 2.1-2.1" />
    <path d="M12.4 13.4h4.7" />
    <path d="M6.8 18.2h9.7" />
  </Glyph>
)

export const IconThink = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M11 3.5 12.8 8.2 17.5 10l-4.7 1.8L11 16.5 9.2 11.8 4.5 10l4.7-1.8Z" />
    <path d="M18.4 14.4l.6 2.2 2.2.6-2.2.6-.6 2.2-.6-2.2-2.2-.6 2.2-.6Z" />
  </Glyph>
)

export const IconTerminal = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <path d="M7.8 9.2l2.6 2.5-2.6 2.5" />
    <path d="M12.8 14.6h3.6" />
  </Glyph>
)

export function RowIcon(props: IconProps & { kind: RowKind }) {
  switch (props.kind) {
    case "read":
      return <IconRead size={props.size} />
    case "search":
      return <IconSearch size={props.size} />
    case "edit":
      return <IconEdit size={props.size} />
    case "write":
      return <IconWrite size={props.size} />
    case "update":
      return <IconUpdate size={props.size} />
    case "test":
      return <IconTest size={props.size} />
    case "bash":
      return <IconBash size={props.size} />
    case "task":
      return <IconTask size={props.size} />
    case "todo":
      return <IconTodo size={props.size} />
    case "think":
      return <IconThink size={props.size} />
    case "terminal":
      return <IconTerminal size={props.size} />
  }
}

const RAYS = Array.from({ length: 12 }, (_, index) => {
  const angle = (index * Math.PI) / 6 - Math.PI / 2 + 0.14
  const inner = 2.5
  const outer = index % 2 === 0 ? 10.4 : 9.7
  return {
    x1: 12 + Math.cos(angle) * inner,
    y1: 12 + Math.sin(angle) * inner,
    x2: 12 + Math.cos(angle) * outer,
    y2: 12 + Math.sin(angle) * outer,
  }
})

export function Starburst() {
  return (
    <svg
      class="starburst"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#e8734a"
      stroke-width="1.6"
      stroke-linecap="round"
      aria-hidden="true"
    >
      {RAYS.map((ray) => (
        <line x1={ray.x1} y1={ray.y1} x2={ray.x2} y2={ray.y2} />
      ))}
    </svg>
  )
}

export function Needle() {
  return (
    <svg
      class="needle"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#d8d8d8"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M18.2 4.2 20 6 6.8 19.2l-2.8.8.8-2.8Z" />
      <path d="M16.7 5.7l1.6 1.6" />
    </svg>
  )
}

export function Spinner() {
  return (
    <span class="spinner">
      <svg width="38" height="38" viewBox="0 0 38 38" fill="none" aria-hidden="true">
        <circle
          cx="19"
          cy="19"
          r="17.25"
          stroke="#e8e8e8"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-dasharray="27.1 81.3"
        />
      </svg>
    </span>
  )
}

export function DoneMark() {
  return (
    <span class="done-badge">
      <svg
        width="36"
        height="36"
        viewBox="0 0 36 36"
        fill="none"
        stroke="#3ed37a"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="18" cy="18" r="16.4" />
        <path d="M11.2 18.6l4.5 4.5 9.2-9.6" />
      </svg>
    </span>
  )
}

export const IconPause = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="6.2" y="3.6" width="4" height="16.8" rx="2" fill="currentColor" stroke="none" />
    <rect x="13.8" y="3.6" width="4" height="16.8" rx="2" fill="currentColor" stroke="none" />
  </Glyph>
)

export const IconPlay = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M8 4.8 19.6 12 8 19.2Z" fill="currentColor" stroke="none" />
  </Glyph>
)

export const IconStop = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
  </Glyph>
)

export const IconCheck = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4.5 12.5 9 17 19.5 6.5" />
  </Glyph>
)

export const IconCross = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5" />
  </Glyph>
)

export const IconArrowUpRight = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M7 17 17 7M8.6 7H17v8.4" />
  </Glyph>
)
