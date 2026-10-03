import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from './Game.js';
import './style.css';

// Physics runs at a fixed rate, independent of the display. Stiff suspension springs
// go unstable with bigger steps, so 120 Hz rather than 60.
const PHYSICS_STEP_SECONDS = 1 / 120;
// After a stall (tab switch, breakpoint) drop the backlog instead of fast-forwarding through it.
const MAX_STEPS_PER_FRAME = 8;
const MAX_FRAME_SECONDS = 0.1;

main();

async function main() {
  await RAPIER.init();
  const game = new Game(
    document.getElementById('game'),
    document.getElementById('hud'),
    PHYSICS_STEP_SECONDS,
  );
  document.getElementById('loading').remove();
  // In development, the game is reachable from the browser console for poking at.
  if (import.meta.env.DEV) window.scrapwind = game;
  runLoop(game);
}

/** Steps physics in fixed slices, then draws once, blending between the last two physics states. */
function runLoop(game) {
  let accumulatedSeconds = 0;
  let lastTime = performance.now();

  function frame(now) {
    const frameSeconds = Math.min((now - lastTime) / 1000, MAX_FRAME_SECONDS);
    lastTime = now;
    accumulatedSeconds += frameSeconds;

    game.beginFrame();
    let steps = 0;
    while (accumulatedSeconds >= PHYSICS_STEP_SECONDS && steps < MAX_STEPS_PER_FRAME) {
      game.step(PHYSICS_STEP_SECONDS);
      accumulatedSeconds -= PHYSICS_STEP_SECONDS;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulatedSeconds = 0;

    game.render(accumulatedSeconds / PHYSICS_STEP_SECONDS, frameSeconds);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
