// Sets the theme before the first paint, so a night window never flashes day paper (and a day one never night).
;(function () {
  var chosen = null
  try {
    chosen = localStorage.getItem("weft.theme")
  } catch (e) {}
  // Development screenshots pick a theme with ?theme=light|dark; index.html fills data-dev per build.
  var dev = document.currentScript && document.currentScript.dataset.dev === "true"
  var forced = dev ? new URLSearchParams(location.search).get("theme") : null
  if (forced === "light" || forced === "dark") chosen = forced
  var dark = chosen ? chosen === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
  var root = document.documentElement
  root.dataset.theme = dark ? "dark" : "light"
  root.style.colorScheme = dark ? "dark" : "light"
})()
