//! Lightweight frame-time telemetry for the render loop.
//!
//! Overhead: two `performance.now()` calls per frame + trivial arithmetic.
//! Emits a summary to the browser console every reporting window.

/// Frames slower than this are counted as "slow" (ms).
const SLOW_THRESHOLD_MS: f64 = 15.0;

/// How often to emit a summary line (ms).
const REPORT_INTERVAL_MS: f64 = 10_000.0;

pub struct FrameStats {
    perf: web_sys::Performance,
    window_start_ms: f64,
    frame_count: u32,
    slow_count: u32,
    max_ms: f64,
    total_ms: f64,
}

impl FrameStats {
    pub fn new() -> Self {
        let perf = web_sys::window()
            .expect("no window")
            .performance()
            .expect("no performance API");
        let now = perf.now();
        Self {
            perf,
            window_start_ms: now,
            frame_count: 0,
            slow_count: 0,
            max_ms: 0.0,
            total_ms: 0.0,
        }
    }

    /// Call at the very start of `update()`. Returns the timestamp.
    pub fn begin(&self) -> f64 {
        self.perf.now()
    }

    /// Call at the very end of `update()` with the value from `begin()`.
    /// Records the frame and emits a summary when the window elapses.
    pub fn end(&mut self, start_ms: f64) {
        let elapsed = self.perf.now() - start_ms;

        self.frame_count += 1;
        self.total_ms += elapsed;
        if elapsed > self.max_ms {
            self.max_ms = elapsed;
        }
        if elapsed > SLOW_THRESHOLD_MS {
            self.slow_count += 1;
        }

        if self.perf.now() - self.window_start_ms >= REPORT_INTERVAL_MS {
            self.report();
        }
    }

    fn report(&mut self) {
        let now = self.perf.now();
        let wall_secs = (now - self.window_start_ms) / 1000.0;
        let avg_ms = if self.frame_count > 0 {
            self.total_ms / f64::from(self.frame_count)
        } else {
            0.0
        };
        let slow_pct = if self.frame_count > 0 {
            f64::from(self.slow_count) / f64::from(self.frame_count) * 100.0
        } else {
            0.0
        };

        if self.slow_count > 0 {
            log::warn!(
                "[perf] {} frames in {wall_secs:.1}s | avg {avg_ms:.1}ms | max {:.1}ms | >{SLOW_THRESHOLD_MS:.0}ms: {} ({slow_pct:.1}%)",
                self.frame_count,
                self.max_ms,
                self.slow_count,
            );
        } else {
            log::info!(
                "[perf] {} frames in {wall_secs:.1}s | avg {avg_ms:.1}ms | max {:.1}ms | all under {SLOW_THRESHOLD_MS:.0}ms",
                self.frame_count,
                self.max_ms,
            );
        }

        self.window_start_ms = now;
        self.frame_count = 0;
        self.slow_count = 0;
        self.max_ms = 0.0;
        self.total_ms = 0.0;
    }
}
