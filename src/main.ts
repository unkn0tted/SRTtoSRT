import "./style.css";
import { mountApp } from "./app";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("App root was not found.");
}

mountApp(root);
