// Exit a test that spawned the MCP server as a child process.
//
// Calling process.exit() right after child.kill() aborts Node on Windows
// with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (libuv,
// src/win/async.c) — the test prints "ALL TESTS PASSED" and still exits
// non-zero. Waiting for the child's stdio to close first avoids it, and it
// also guarantees a failing test never leaves an orphan server holding a
// bridge port.
let exiting = false;
export function exitAfterChild(child, code) {
  if (exiting) return;
  exiting = true;
  const done = () => setTimeout(() => process.exit(code), 200);
  if (!child || child.exitCode !== null || child.signalCode !== null) return done();
  child.once("close", done);
  child.kill();
  // Last resort if the child ignores the signal.
  setTimeout(() => process.exit(code), 5000).unref();
}
