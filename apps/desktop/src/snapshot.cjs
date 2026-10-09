// @ts-check
/**
 * Development aid: drive the app through a few steps, save screenshots, and
 * quit. Lets you (or an agent) check layouts without looking at the screen.
 *
 *   LINAW_SNAPSHOT=out.png        where the final screenshot goes
 *   LINAW_SNAPSHOT_DELAY=4000     ms to wait before the final screenshot
 *   LINAW_SNAPSHOT_STEP=1500      ms to wait before each step
 *   LINAW_SNAPSHOT_CLICK="Start listening>>wait:20000>>Notes>>fill:Write a note…=Ask about SALN>>Add note>>shot:notes.png"
 *
 * Steps, separated by >>:
 *   <text>               click the first button whose text or aria-label contains <text>
 *   wait:<ms>            wait
 *   fill:<placeholder>=<value>   type into the input/textarea with that placeholder
 *   shot:<file.png>      save a screenshot next to LINAW_SNAPSHOT
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {import('electron').BrowserWindow} win */
function scheduleSnapshot(win) {
  const out = /** @type {string} */ (process.env.LINAW_SNAPSHOT);
  const delay = Number(process.env.LINAW_SNAPSHOT_DELAY ?? 4000);
  const stepMs = Number(process.env.LINAW_SNAPSHOT_STEP ?? 1500);
  const steps = (process.env.LINAW_SNAPSHOT_CLICK ?? '').split('>>').filter(Boolean);

  /** @param {string} file */
  const shot = async (file) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(file, image.toPNG());
    console.log(`[snapshot] wrote ${file}`);
  };

  win.webContents.once('did-finish-load', async () => {
    for (const step of steps) {
      if (step.startsWith('wait:')) {
        await sleep(Number(step.slice(5)));
        continue;
      }
      await sleep(stepMs);
      if (step.startsWith('shot:')) {
        await shot(path.join(path.dirname(out), step.slice(5)));
      } else if (step.startsWith('fill:')) {
        const [placeholder, value] = step.slice(5).split('=');
        const ok = await win.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector(${JSON.stringify(`[placeholder="${placeholder}"]`)});
            if (!el) return false;
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value ?? '')});
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })()`,
          true,
        );
        if (!ok) console.warn(`[snapshot] no field with placeholder "${placeholder}"`);
      } else {
        const clicked = await win.webContents.executeJavaScript(
          `(() => {
            const want = ${JSON.stringify(step)};
            const button = [...document.querySelectorAll('button')].find(
              (b) => b.textContent.includes(want) || (b.getAttribute('aria-label') ?? '').includes(want),
            );
            button?.click();
            return Boolean(button);
          })()`,
          true,
        );
        if (!clicked) console.warn(`[snapshot] no button with text or label "${step}"`);
      }
    }
    await sleep(delay);
    await shot(out);
    app.quit();
  });
}

module.exports = { scheduleSnapshot };
