// Import only Oat primitives used by this app; MapLibre styles load with the map.
import "@knadh/oat/css/00-base.css";
import "@knadh/oat/css/01-theme.css";
import "@knadh/oat/css/button.css";
import "@knadh/oat/css/form.css";
import "@knadh/oat/css/card.css";
import "@knadh/oat/css/badge.css";
import "@knadh/oat/css/avatar.css";
import "@knadh/oat/css/accordion.css";
import "@knadh/oat/css/alert.css";
import "@knadh/oat/css/dropdown.css";
import "@knadh/oat/css/dialog.css";
import "@knadh/oat/css/spinner.css";
import "@knadh/oat/css/toast.css";
import "@knadh/oat/css/animations.css";
import "@knadh/oat/css/utilities.css";
import "@knadh/oat/js/dropdown.js";
import "./styles.css";
import { createApp } from "./App";

const app = createApp(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.dispose(() => app.destroy());
