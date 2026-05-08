import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FRAMES = ["·", "•", "●", "◆", "●", "•"] as const;
const INTERVAL_MS = 140;

function applyWorkingIndicator(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setWorkingIndicator({
    frames: FRAMES.map((frame, index) => {
      if (index === 3) return ctx.ui.theme.fg("accent", frame);
      if (index === 2 || index === 4) return ctx.ui.theme.fg("muted", frame);
      return ctx.ui.theme.fg("dim", frame);
    }),
    intervalMs: INTERVAL_MS,
  });
}

export default function working(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => applyWorkingIndicator(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWorkingIndicator();
  });
}
