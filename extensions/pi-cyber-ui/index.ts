import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import editor from "./editor.js";
import footer from "./footer.js";
import toolRender from "./tool-render.js";
import { wireToolRegistry } from "./tool-registry.js";
import working from "./working.js";

export default function piCyberUi(pi: ExtensionAPI) {
  wireToolRegistry(pi);
  // cyberState producer must register before consumers (working/footer).
  editor(pi);
  toolRender(pi);
  footer(pi);
  working(pi);
}
