import type { Locator, Page } from 'playwright';

/**
 * Natural-looking pointer movement. The store gates its "Reveal price" button on
 * how the pointer moved over the price area, so a scraper has to actually move
 * the mouse the way a person does: a curved path, accelerating and decelerating,
 * sampled at roughly display rate, with a short pause before pressing.
 * All of this goes through Playwright's real input pipeline (trusted events).
 */

interface Pt {
  x: number;
  y: number;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

const position = new WeakMap<Page, Pt>();

function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** Glide from the current position to `to` along a slightly randomised curve. */
export async function glideTo(page: Page, to: Pt): Promise<void> {
  const from = position.get(page) ?? { x: rand(5, 60), y: rand(5, 60) };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return;

  // Control points bow the path sideways a little, like a wrist arc.
  const bow = Math.min(90, dist * 0.25);
  const nx = -dy / dist;
  const ny = dx / dist;
  const c1 = { x: from.x + dx * 0.3 + nx * rand(-bow, bow), y: from.y + dy * 0.3 + ny * rand(-bow, bow) };
  const c2 = { x: from.x + dx * 0.7 + nx * rand(-bow, bow), y: from.y + dy * 0.7 + ny * rand(-bow, bow) };

  const duration = Math.min(1400, Math.max(320, dist * 1.4 + rand(120, 320)));
  const frames = Math.max(10, Math.round(duration / 16));
  for (let i = 1; i <= frames; i++) {
    const p = bezier(from, c1, c2, to, easeInOut(i / frames));
    // sub-pixel hand tremor, fading out as the pointer arrives
    const tremor = (1 - i / frames) * 1.2;
    await page.mouse.move(p.x + rand(-tremor, tremor), p.y + rand(-tremor, tremor));
    await sleep((duration / frames) * rand(0.8, 1.25));
  }
  position.set(page, to);
}

/** A random point inside a box, kept away from its edges. */
export function pointIn(box: { x: number; y: number; width: number; height: number }, margin = 8): Pt {
  return {
    x: box.x + rand(margin, Math.max(margin + 1, box.width - margin)),
    y: box.y + rand(margin, Math.max(margin + 1, box.height - margin)),
  };
}

/** Enter an area from outside and wander inside it for a moment, as if reading. */
export async function wanderOver(page: Page, area: Locator): Promise<void> {
  const box = await area.boundingBox();
  if (!box) return;
  const cur = position.get(page);
  if (!cur || (cur.x > box.x && cur.x < box.x + box.width && cur.y > box.y && cur.y < box.y + box.height)) {
    // approach from the left margin so there is a genuine "enter" event
    position.set(page, { x: Math.max(3, box.x - rand(60, 160)), y: box.y + rand(-30, box.height) });
  }
  for (let i = 0; i < 3; i++) {
    await glideTo(page, pointIn(box));
    await sleep(rand(120, 320));
  }
}

/** Move onto an element and press it with a natural down/up gap. */
export async function humanClick(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('click target has no bounding box');
  await glideTo(page, pointIn(box, Math.min(10, box.height / 3)));
  await sleep(rand(140, 320));
  await page.mouse.down();
  await sleep(rand(45, 120));
  await page.mouse.up();
}
