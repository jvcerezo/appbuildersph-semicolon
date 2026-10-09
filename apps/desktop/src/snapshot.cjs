// @ts-check
/**
 * Development aid: save a screenshot of the overlay and quit. Lets you (or an
 * agent) check the layout without looking at the screen.
 *
 *   LINAW_SNAPSHOT=out.png              path of the PNG to write
 *   LINAW_SNAPSHOT_DELAY=4000           ms to wait after the page loads
 *   LINAW_SNAPSHOT_CLICK="Start listening>>Summary"
 *                                       optional: click the first button with
 *                                       each text in turn (as real user gestures)
 *   LINAW_SNAPSHOT_STEP=1500            ms between clicks
 */
const fs = require('node:fs');
const { app } = require('electron');

/** @param {import('electron').BrowserWindow} win */
function scheduleSnapshot(win) {
  const out = /** @type {string} */ (process.env.LINAW_SNAPSHOT);
  const delay = Number(process.env.LINAW_SNAPSHOT_DELAY ?? 4000);
  const clicks = (process.env.LINAW_SNAPSHOT_CLICK ?? '').split('>>').filter(Boolean);
  const step = Number(process.env.LINAW_SNAPSHOT_STEP ?? 1500);

  win.webContents.once('did-finish-load', async () => {
    for (const text of clicks) {
      await new Promise((r) => setTimeout(r, step));
      const script = `(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}));
        button?.click();
        return Boolean(button);
      })()`;
      const clicked = await win.webContents.executeJavaScript(script, true);
      if (!clicked) console.warn(`[snapshot] no button with text "${text}"`);
    }
    await new Promise((r) => setTimeout(r, delay));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(out, image.toPNG());
    console.log(`[snapshot] wrote ${out}`);
    app.quit();
  });
}

module.exports = { scheduleSnapshot };
