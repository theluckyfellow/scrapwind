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
  let game;
  try {
    await RAPIER.init();
    game = new Game(
      document.getElementById('game'),
      document.getElementById('hud'),
      PHYSICS_STEP_SECONDS,
    );
  } catch (error) {
    // Never leave the player staring at an eternal loading screen with no clue why.
    console.error(error);
    document.getElementById('loading').textContent = `Scrapwind failed to start: ${error.message}. Reload, or open the browser console for the full error.`;
    return;
  }
  document.getElementById('loading').remove();
  // In development, the game is reachable from the browser console for poking at.
  if (import.meta.env.DEV) window.scrapwind = game;
  runLoop(game);
}

let reportedErrors = 0;
const MAX_REPORTED_ERRORS = 5;

/** Logs a frame error (only the first few, so a per-frame fault can't flood the console). */
function reportFrameError(error) {
  if (reportedErrors >= MAX_REPORTED_ERRORS) return;
  reportedErrors++;
  console.error(reportedErrors === MAX_REPORTED_ERRORS ? '(further frame errors silenced)' : 'Frame error:', error);
}

/** Steps physics in fixed slices, then draws once, blending between the last two physics states. */
function runLoop(game) {
  let accumulatedSeconds = 0;
  let lastTime = null;

  function frame(now) {
    // Ask for the next frame first: one frame that throws must never freeze the whole game.
    requestAnimationFrame(frame);
    // A frame timestamp can come out earlier than the last one (notably the first frame after a long load);
    // counted as negative time it would freeze physics until the clock caught up, so it counts as none.
    const frameSeconds = lastTime === null ? 0 : Math.min(Math.max((now - lastTime) / 1000, 0), MAX_FRAME_SECONDS);
    lastTime = now;
    accumulatedSeconds += frameSeconds;

    try {
      game.beginFrame();
      let steps = 0;
      while (accumulatedSeconds >= PHYSICS_STEP_SECONDS && steps < MAX_STEPS_PER_FRAME) {
        game.step(PHYSICS_STEP_SECONDS);
        accumulatedSeconds -= PHYSICS_STEP_SECONDS;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) accumulatedSeconds = 0;
      game.render(accumulatedSeconds / PHYSICS_STEP_SECONDS, frameSeconds);
    } catch (error) {
      reportFrameError(error);
    }
  }

  requestAnimationFrame(frame);
}
