import { render } from "solid-js/web"
import "@fontsource-variable/geist"
import "./topbar.css"
import { App } from "./App"

const demo = new URLSearchParams(window.location.search).get("demo")

render(() => <App demo={demo} />, document.getElementById("root")!)
