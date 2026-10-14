import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { startIdleShutdown } from './idle-shutdown.js';

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  jest.useRealTimers();
});

function watcher(state: { browsers: number; sessions: number; native: boolean }) {
  const onIdle = jest.fn();
  stop = startIdleShutdown(
    {
      connectedBrowsers: () => state.browsers,
      activeSessions: () => state.sessions,
      nativePeerConnected: () => state.native,
    },
    onIdle,
    1_000,
    5_000,
  );
  return onIdle;
}

describe('idle shutdown', () => {
  test('exits once nothing has used the server for the full window', () => {
    jest.useFakeTimers();
    const state = { browsers: 0, sessions: 0, native: false };
    const onIdle = watcher(state);

    jest.advanceTimersByTime(4_000);
    expect(onIdle).not.toHaveBeenCalled();

    jest.advanceTimersByTime(3_000);
    expect(onIdle).toHaveBeenCalled();
  });

  test('a live MCP session keeps it up with no browsers attached', () => {
    jest.useFakeTimers();
    const state = { browsers: 0, sessions: 1, native: false };
    const onIdle = watcher(state);

    // Counting only browsers would exit under the client here.
    jest.advanceTimersByTime(30_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  test('a browser returning inside the window cancels the shutdown', () => {
    jest.useFakeTimers();
    const state = { browsers: 0, sessions: 0, native: false };
    const onIdle = watcher(state);

    jest.advanceTimersByTime(3_000);
    state.browsers = 1;
    jest.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();

    // And the window restarts from scratch rather than resuming where it stopped.
    state.browsers = 0;
    jest.advanceTimersByTime(4_000);
    expect(onIdle).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3_000);
    expect(onIdle).toHaveBeenCalled();
  });

  test('a native peer still bootstrapping is enough to stay up', () => {
    jest.useFakeTimers();
    const state = { browsers: 0, sessions: 0, native: true };
    const onIdle = watcher(state);

    // Exiting here would drop a browser mid-bootstrap, which re-bootstraps and
    // spawns us again: a loop rather than a shutdown.
    jest.advanceTimersByTime(30_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
