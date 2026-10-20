/** The mark: the name in Fraunces italic and a drop of ink beside it, which ripples while a reply flows. */
export function Mark(props: { live?: boolean }) {
  return (
    <span class="mark" classList={{ live: props.live }} aria-label="weft">
      <svg class="mark-drop" width="12" height="15" viewBox="0 0 12 15" aria-hidden="true">
        <path d="M6 .8C6 .8 1 6.6 1 9.6a5 5 0 0 0 10 0C11 6.6 6 .8 6 .8Z" />
      </svg>
      <span class="mark-name">weft</span>
    </span>
  )
}
