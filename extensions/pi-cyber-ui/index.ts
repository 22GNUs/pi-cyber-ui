import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import editor from "./editor.js";
import footer from "./footer.js";
import working from "./working.js";

export default function piCyberUi(pi: ExtensionAPI) {
  footer(pi);
  working(pi);
  editor(pi);
}
