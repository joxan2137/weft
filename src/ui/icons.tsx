import type { JSX } from "solid-js"

type IconProps = { size?: number; class?: string }

function Icon(props: IconProps & { children: JSX.Element; view?: string }) {
  return (
    <svg
      class={`icon ${props.class ?? ""}`}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox={props.view ?? "0 0 16 16"}
      fill="none"
      stroke="currentColor"
      stroke-width="1.25"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  )
}

export const IconNeedle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 13 12.6 3.4a1.1 1.1 0 0 1 1.6 1.6L4.6 14.6Z" />
    <path d="M11.2 4.8l1.6 1.6" />
    <path d="M3 13c-1.5 1-1.6 2.2-.4 2.2" />
  </Icon>
)

export const IconFork = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 15V9.5C8 7 4.5 6.5 4.5 3.5V1.5" />
    <path d="M8 9.5C8 7 11.5 6.5 11.5 3.5V1.5" />
    <circle cx="8" cy="9.5" r="0.6" fill="currentColor" />
  </Icon>
)

export const IconScissors = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="4" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <path d="M5.4 10.6 12 2M10.6 10.6 4 2" />
  </Icon>
)

export const IconCopy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
    <path d="M10.5 3.5V3a.5.5 0 0 0-.5-.5H3a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h.5" />
  </Icon>
)

export const IconSpool = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 2.5h9M3.5 13.5h9" />
    <path d="M5 2.5v11M11 2.5v11" />
    <path d="M5 5l6 1.5M5 7.5l6 1.5M5 10l6 1.5" stroke-width="1" />
  </Icon>
)

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
)

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.2 10.2 3.3 3.3" />
  </Icon>
)

export const IconChevron = (p: IconProps & { dir?: "down" | "up" | "right" }) => (
  <Icon {...p}>
    <path
      d={p.dir === "up" ? "M4 10l4-4 4 4" : p.dir === "right" ? "M6 4l4 4-4 4" : "M4 6l4 4 4-4"}
    />
  </Icon>
)

export const IconCloth = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke-width="1" />
    <path d="M4.5 2.5v3M4.5 6.5v3M4.5 10.5v3M8 2.5v1M8 5v6M8 12.5v1M11.5 2.5v3M11.5 6.5v3M11.5 10.5v3" />
  </Icon>
)

export const IconClose = (p: IconProps) => (
  <Icon {...p} view="0 0 12 12">
    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke-width="1" />
  </Icon>
)

export const IconShuttle = (p: IconProps) => (
  <Icon {...p} view="0 0 20 16">
    <path d="M1.5 8C5.5 4.5 14.5 4.5 18.5 8 14.5 11.5 5.5 11.5 1.5 8Z" />
    <path d="M7.5 8h5" stroke-width="1.6" />
  </Icon>
)

export const IconPin = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.5 4.5 5 10a1.8 1.8 0 0 0 2.5 2.5l6-6a3 3 0 0 0-4.2-4.2L3.2 8.4a4.2 4.2 0 0 0 6 6L13 10.6" />
  </Icon>
)

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
)

export const IconCross = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
)

export const IconTerminal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 4.5l3.5 3.5L3 11.5M8 11.5h5" />
  </Icon>
)

export const IconFile = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 1.5h5.5L12.5 4.5v10h-8.5Z" />
    <path d="M9.5 1.5v3h3" />
  </Icon>
)

export const IconGear = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </Icon>
)

export const IconFolder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M1.5 4a1 1 0 0 1 1-1h3.2l1.5 1.5h6.3a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" />
  </Icon>
)

export const IconImage = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="1" />
    <circle cx="5.8" cy="6" r="1.1" />
    <path d="m2.5 12 3.8-3.6 2.4 2.2 2-1.8 2.8 2.6" />
  </Icon>
)

export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6" />
    <path d="M11.8 1.8v2.9H8.9" />
  </Icon>
)

export const IconOpen = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12.5 9v3.5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1H7" />
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
  </Icon>
)

export const IconSlash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.5 2.5 5.5 13.5" />
  </Icon>
)

export const IconKey = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="11" r="2.5" />
    <path d="M6.8 9.2 13 3M11 5l1.6 1.6M9.4 6.6l1.2 1.2" />
  </Icon>
)

export const IconPlug = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 1.5v3M10 1.5v3" />
    <path d="M4 4.5h8V7a4 4 0 0 1-8 0Z" />
    <path d="M8 11v3.5" />
  </Icon>
)

export const IconTurn = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 5.5h11M2.5 10.5h11" />
    <path d="M5 3 2.5 5.5 5 8M11 8l2.5 2.5L11 13" />
  </Icon>
)

export const IconTool = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.6 2.2a3 3 0 0 0-3.5 3.9l-4.5 4.5a1.2 1.2 0 0 0 1.7 1.7l4.5-4.5a3 3 0 0 0 3.9-3.5l-1.8 1.8-1.7-.4-.4-1.7Z" />
  </Icon>
)

export const IconMore = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconDrop = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 1.8C8 1.8 3.6 6.9 3.6 9.8a4.4 4.4 0 0 0 8.8 0C12.4 6.9 8 1.8 8 1.8Z" />
  </Icon>
)

export const IconSettle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 5.5c1.8-1.2 3.7-1.2 5.5 0s3.7 1.2 5.5 0" />
    <circle cx="8" cy="11.5" r="1.6" />
  </Icon>
)

export const IconArrow = (p: IconProps & { dir?: "up" | "down" }) => (
  <Icon {...p}>
    <path d={p.dir === "down" ? "M8 3v10M4 9l4 4 4-4" : "M8 13V3M4 7l4-4 4 4"} />
  </Icon>
)

export const IconStop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconSidebar = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="2.5" />
    <path d="M6.2 2.5v11" />
  </Icon>
)

export const IconPanel = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="2.5" />
    <path d="M9.8 2.5v11" />
  </Icon>
)

export const IconWaves = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 5c1.5-1 3-1 4.5 0s3 1 4.5 0 2-.7 3-.3" />
    <path d="M2 8.5c1.5-1 3-1 4.5 0s3 1 4.5 0 2-.7 3-.3" />
    <path d="M2 12c1.5-1 3-1 4.5 0s3 1 4.5 0 2-.7 3-.3" />
  </Icon>
)

export const IconDiff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 2.5v6M2 5.5h6M8.5 12h5.5" />
    <path d="M10.5 3.5 13 6l-2.5 2.5" stroke-width="1" />
  </Icon>
)

export const IconMin = (p: IconProps) => (
  <Icon {...p} view="0 0 12 12">
    <path d="M2 6h8" stroke-width="1" />
  </Icon>
)

export const IconMax = (p: IconProps) => (
  <Icon {...p} view="0 0 12 12">
    <rect x="2" y="2" width="8" height="8" rx="1.5" stroke-width="1" />
  </Icon>
)

export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
  </Icon>
)

export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.4 9.6A5.6 5.6 0 0 1 6.4 2.6a5.6 5.6 0 1 0 7 7Z" />
  </Icon>
)
