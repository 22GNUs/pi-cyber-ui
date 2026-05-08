import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import editor from "./editor.js";
import footer from "./footer.js";
import working from "./working.js";

export default function piCyberUi(pi: ExtensionAPI) {
  footer(pi);
  working(pi);
  editor(pi);
}
