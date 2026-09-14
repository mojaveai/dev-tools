# CAPTCHA comparison investigation — 2026-09-14

## Goal and measurement

The target is reliable shared-browser handoff within a few challenge rounds,
without extra retries caused by rendering or input forwarding. A single green
check does not establish reliability or equivalence of outcome distributions.

Count separately for each fresh widget attempt:

- checkbox-only completion;
- challenge rounds (each Next or Verify submission);
- dynamic image replacement cycles and total tile selections;
- explicit rejection messages, expiration, and transport/rendering failures;
- completion within three submitted rounds, elapsed time, and final checkbox state.

Three rounds is the initial practical success threshold, not a provider promise.
Small samples are diagnostic; report denominators and uncertainty rather than
claim statistical equivalence. Repeated attempts may affect later challenges.
Alternate input paths within a browser, record ordering, and keep browser,
profile, network, viewport, recorder, and solver constant in that comparison.

## Comparison chain

1. Existing Mac Chrome profile: native extension element versus coordinate click.
2. One existing remote visible Chrome profile: direct CDP coordinate input,
   native desktop input, and shared-viewer input. Keep recorder attached in all
   three arms. The shared arm must act on the replay's observed geometry.
3. Compare recording attached versus absent independently of the input route.
4. Compare main browser launch/environment with the visible browser. Profile
   and machine comparisons are not controlled evidence for an input defect.
5. Repair measured defects, run deterministic event/rendering regressions, and
   repeat real-widget comparisons. Test the real tailnet viewer, not only a
   loopback test viewer. Do not fabricate human-like trajectories, change
   fingerprint properties, or treat test keys as evidence of real acceptance.

For shared comparisons, match source and replay by tab ID and document generation;
compare visible instructions, loaded image pixels, selected tiles, geometry,
and source-observed event ordering/coordinates/button state. Record missing or
stale observations as failures rather than silently reloading them away.

## Current measurements

| Attempt | Environment / route | Checkbox only | Submitted rounds | Rejections | Result |
| --- | --- | --- | --- | --- | --- |
| M1 | Existing Mac Chrome / native extension element click | yes | 0 | 0 | passed |
| M2 | Same Mac Chrome / native extension coordinate click | yes | 0 | 0 | passed |
| M3 | Same Mac Chrome / native extension element click | yes | 0 | 0 | passed |
| M4 | Same Mac Chrome / native extension coordinate click | yes | 0 | 0 | passed |
| R1 | Remote visible profile / shared viewer | no | 1 | 0 | passed |
| R2 | Same remote profile / direct CDP coordinates | no | 1 | 0 | passed |
| R3 | Same remote profile / native X11 desktop input | no | 1 | 0 | passed |
| R4 | Same remote profile / native X11 desktop input | no | 1 | 0 | passed |
| R5 | Same remote profile / direct CDP coordinates | no | 1 | 0 | passed |
| R6 | Same remote profile / shared viewer | no | 1 | 0 | passed |
| R7 | Same remote profile / shared viewer | no | 1 | 0 | passed |
| R8 | Same remote profile / direct CDP coordinates | no | 1 | 0 | passed |
| R9 | Same remote profile / native X11 desktop input | no | 2 | 1* | passed |

M1 and M2 used the public Google reCAPTCHA demo. Each result was verified through
the source checkbox's accessibility value; M1 was also visually inspected.

Observed remote environments before new trials:

- Main: Chrome 153.0.8010.12, headless UA, `navigator.webdriver=true`, screen
  800×600; inspected tab viewport 1920×963 and outer window 780×493.
- Comparison desktop: same Chrome version, visible UA, `webdriver=false`,
  screen 1440×900; inspected tab viewport 1042×733 and outer window 1050×880.

These are real launch/environment differences, not proof of the provider's
reason for challenging or rejecting an attempt. The previous one-off tests
produced successes and rejections and did not establish distributional parity.

The first shared/direct remote pair matched prompt text and decoded image pixels.
The raw class comparison flagged rrweb’s synthetic `:hover` class; inspecting
the diff showed identical tile bounds and actual selection states. This is an
audit normalization issue, not evidence of a stale image or misplaced click.
Native desktop input uses X11 events through xdotool on the existing authenticated
private comparison display; it does not traverse CDP input or shared forwarding.

R1–R9 ran in that order using a single comparison tab/profile/viewport, with
recording and a loopback shared viewer attached throughout. R9 initially missed
a replacement crosswalk image: the widget said “Please also check the new
images.” After correcting that selection and checking another replacement, the
second submission passed. This is included as an unsuccessful submission, not
attributed to the forwarding layer. All source-observed clicks were trusted,
with separate press/release and one click; no image/prompt divergence was found.
The native X11 position differed by one vertical pixel from fractional CDP
centers because X11 uses integer screen coordinates.

Private raw observations and screenshots for R1–R9 are on procbox at
`/tmp/captcha-trials-GLHWUZ/`. They contain only the public demo, image checksums,
and input telemetry; no reCAPTCHA response tokens or cookies were collected.

## Main-profile comparison

H1 (direct CDP, normal headless profile) had not passed after three Next
submissions; the next challenge was still open. H2 (shared input, same profile)
also had not passed after three submissions. H2 had one missed replacement
crosswalk corrected after “Please also check the new images,” followed by two
“Please try again” responses. The bus round included seven correctly relayed
tile selections across four batches; final acceptance was still rejected.
Do not assume visual answers are an objective answer key.

For every sampled H1/H2 observation, source and replay matched visible prompt,
decoded pixels, loaded state, selected tiles, and tile geometry (after normalizing
rrweb’s synthetic hover class). Raw records: procbox
`/tmp/captcha-trials-7rYiiR/`. Both attempts are censored after the three-round
threshold; they are not counted as eventual failures or eventual passes.

The next experiment launched the same main Chrome binary and existing profile
as a normal visible browser on an authenticated local Xvfb display. The shared
service connects to its loopback CDP endpoint. It does not override navigator
properties or inject fingerprint patches. This changes the launch configuration
as a group (including headless/automation launch flags and display dimensions);
it cannot isolate which individual field influences provider decisions.
The previous 13 tab URLs were saved privately and reopened after the controlled
restart. No profile deletion, cookie reset, or credential export was performed.

## Same-profile normal launch, then return-to-headless control

| Attempt | Main profile input | Launch | Rounds | Try-again responses | Within 3 rounds |
| --- | --- | --- | --- | --- | --- |
| N1 | shared | normal Chrome | 2 | 1 | yes |
| N2 | direct CDP | normal Chrome | 1 | 0 | yes |
| N3 | direct CDP | normal Chrome | 1 | 0 | yes |
| N4 | shared | normal Chrome | 1 | 0 | yes |
| N5 | shared | normal Chrome | 1 | 0 | yes |
| N6 | direct CDP | normal Chrome | 1 | 0 | yes |
| H3 | direct CDP | headless control | 3 | 2 | yes |
| H4 | shared | headless control | 3 (stopped) | 3 | no |

N1’s first motorcycle grid included an ambiguous sidecar vehicle; its selection
may have been wrong. Keep that rejection in the reported result. N4 included
a dynamic crosswalk replacement and passed in one submitted round.

The return-to-headless control used the original Puppeteer launch configuration
and the same profile/binary, with a fixed loopback debugging port so the receiver
could remain an external attachment. Headless input again required additional
rounds on both paths; H4 was not complete at the predefined three-round cutoff.
This supports a launch/environment effect rather than a defect unique to shared
input, while leaving individual provider signals and image-answer errors unresolved.

Raw records: procbox `/tmp/captcha-trials-obbDlC/` (N1–N6) and
`/tmp/captcha-trials-JSRVJX/` (H3–H4). No browser fingerprint properties were patched.
The regular local profile passed 4/4 checkbox-only trials; that cross-device
difference cannot be attributed solely to the connector because profile, network,
and device differ. Normal remote Chrome still received image challenges.

These diagnostic samples are too small to demonstrate statistical equivalence
of full distributions. For example, 3/3 successes has a 95% Wilson interval of
about 44–100%, not a proven 100% underlying success rate. The current operational
target is completion within three submitted rounds with no forwarding/rendering
failures; broader reliability needs a larger balanced sample and real-viewer tests.

## Permanent-engine validation protocol

After deployment, run a fixed block of 30 direct-coordinate and 30 shared-viewer
attempts on the same main profile, alternating ABBA order, with the default
zero-delay Puppeteer click in both arms. Keep the remote Chrome process, network,
viewport, recorder, and observer constant. Each new widget is one attempt; stop
at three submitted rounds or explicit expiration. Record every attempt, including
solver mistakes. Do not extend or discard attempts in response to their outcome.

Primary comparison: completion within three rounds. Report the difference in
success proportions with a 90% Newcombe interval; a predeclared practical
non-inferiority margin is 10 percentage points (shared minus direct > -0.10).
Also report the empirical CDF at zero, one, two and three rounds, rejection count,
expiration, and rendering/input defects. This sample cannot prove equality of
complete distributions, nor equality across the Mac and remote profiles.

## Validation results and acceptance status

**The requested reliability/equivalence goal is not achieved.** The normal
desktop launch is installed and the shared transport passes its deterministic
checks, but the full real-widget sample did not meet the predeclared margin.

| Metric | Direct CDP in source Chrome | Shared viewer into the same Chrome |
| --- | ---: | ---: |
| Fresh attempts | 30 | 30 |
| Checkbox only | 0 | 0 |
| Completed by one submission | 16/30 | 15/30 |
| Completed by two submissions | 24/30 | 22/30 |
| Completed by three submissions | 24/30 | 23/30 |
| Explicit try-again responses | 7 | 13 |
| Expired attempts | 1 | 3 |
| Median tile selections per attempt | 7.5 | 5.5 |
| Median observed elapsed seconds | 39.5 | 35.65 |

The shared-minus-direct completion difference is **−3.33 percentage points**.
The specified 90% Newcombe interval is **−20.61 to +14.17 points**; its lower
bound is below the −10-point margin. Even treating the attempts as independent
would not establish non-inferiority. In fact, attempts share a profile/network
and clearly change with order, so that binomial interval is descriptive and
should not be presented as a valid guarantee for future user sessions.

The first 40 attempts completed within the cutoff in 20/20 direct and 19/20 shared
trials; the last 20 completed in 4/10 for each route. This late deterioration
occurred on both routes. Provider adaptation, browser/network history, and solver
errors remain possible explanations; the data do not reveal Google's internal
decision. Elapsed time includes model reasoning, tool round trips, screenshots,
and deliberate observation waits. It is **not** transport latency. Expiration
and any incorrect selections remain in the denominators.

All **268 observations taken after a settling wait** matched source/replay prompt
text, image decode checksums and loaded state, tile selection classes, and tile
geometry. Immediate zero-wait observations sometimes captured an update in flight;
those raw records are retained. These samples do not rule out every transient
rendering issue, other CAPTCHA provider, or untested mobile input path.

The sanitized ordered results are in
[captcha-validation-2026-09-14.json](captcha-validation-2026-09-14.json).
Regenerate them with `python3 shared_browser/test/summarize-captcha.py OBSERVATIONS`.
The V01–V60 block is in procbox `/tmp/captcha-trials-iImGFi/observations.jsonl`;
that directory also contains the earlier T5 observation and private asset audit.
No response tokens or cookies are in the diagnostic logs.

## Actual Mac viewer over the tailnet

T1–T5 used the existing Mac Chrome extension to operate the published DOM viewer
at procbox:8443, with the source still on procbox. T1 expired during a long dynamic
car challenge after two submissions and 17 tile selections; model/tool delays
contributed to elapsed time. Keep it as an incomplete attempt. T2 passed in one
round using a fixed 120 ms press. T3 and T5 passed in one round and T4 in two using
the extension's default fast coordinate clicks. T4's first submission was Next,
not an explicit rejection. Thus short click duration is not, by itself, a
reproducible cause of failure.

One exact challenge image audited on both machines had identical original
encoded bytes (38,059 bytes, SHA-256
`4280c90c6cbe664d4bf6af87354a6f552dbd5fb0e7fbfde12a8cfd3f4ab98458`).
Decoded pixel hashes differed across Mac/Linux, but 4×4 regional RGB means
differed by at most about 0.05/255. For this image, the discrepancy was decoder
rounding, not stale or corrupted delivery. Do not generalize this single byte
audit to every image. T1–T4 records: `/tmp/captcha-trials-nY0lJn/`.

## Recorder on/off control

O1–O4 used fresh targets in the same persistent normal Chrome process/profile,
1920×963 viewport, and default zero-delay direct CDP input. Before every trial
the receiver was stopped and the previous test target closed. For the off arm,
the new target was created while the receiver remained stopped; each frame was
checked for absence of `__sharedStop`, `__sharedMirror`, and `__sharedEmit`.
Simply stopping an existing recorder would not remove its earlier patches.
For the on arm, the receiver was started before creating the new target.

| Trial | Recorder | Rounds | Tiles | Try-again | Outcome |
| --- | --- | ---: | ---: | ---: | --- |
| O1 | off | 2 | 7 | 1 | passed |
| O2 | on | 1 | 8 | 1 | interrupted by operator error |
| O3 | on | 3 | 28 | 2 | expired |
| O4 | off | 3 | 9 | 0 | still receiving Next challenges at cutoff |

O2 was accidentally advanced to the next trial before its outcome was terminal.
It is retained as a protocol deviation, not dropped or counted as a completed
three-round failure. No comparative pass-rate inference is justified by this
tiny, partly interrupted control. O1 independently reproduced delayed dynamic
replacement and a rejection with no recorder; O4 reproduced additional rounds
with no recorder. That rules out shared forwarding/recording as the **sole**
cause of these symptoms, not every possible recorder contribution. O1 included
an ambiguous dark vehicle; O3 had severely degraded source images, uncertain
bus selections, and 272 seconds of solver/observation time before expiration.

The receiver was restored and the test target closed. Chrome's PID did not change.
Raw records: `/tmp/captcha-recorder-control-MYAe4X/`. The diagnostic harness is
`test/captcha-recorder-control.mjs`; it always restores the receiver on normal exit.

## Engineering changes and remaining investigation

- Normal Chrome now runs under its own user service on an authenticated local
  Xvfb display. It keeps the existing profile, survives receiver updates, and
  does not require a connected Mac or viewer. No VNC/pixel listener is involved.
- `tab.click([x, y])` now supports native-style source-viewport coordinates,
  including cross-origin controls, through the ordinary agent queue/feedback.
- Receiver reattachment preserves the running document's recorder/mirror and
  selects Chrome's focused tab. It no longer silently switches to the first tab.
- Unit checks: 33 passed. Procbox and demobox passed isolated native-host tests
  for normal browser properties, cross-origin MCP coordinates, and receiver
  restarts preserving Chrome and unsaved parent/child inputs. Additional procbox
  checks covered repeated receiver restarts followed by navigation. The iframe
  suite passed 12 checks; the navigation suite passed eight.

The full installer was rerun on demobox while a disposable page contained an
unsaved input. Chrome's PID and that input survived, and typing continued after
installation. A navigation-suite rerun initially collided with the iframe suite's
fixed fixture port; it passed when run after the iframe suite finished. Run those
two suites sequentially.

The installed browser executable is the existing Chromium-compatible binary
from the browser provisioner, launched normally rather than by Puppeteer launch.
Procbox also has system Google Chrome 153.0.8010.36; a controlled binary comparison
has **not** been performed. Do not attribute results to a particular fingerprint
field, branding, IP reputation, or connector implementation without that control.

Further useful acceptance work should use spaced, prospectively scheduled human
handoffs and matched direct/shared paths on the same browser. Repeating challenges
until several pass would hide the observed time/order effects. Matching an
established Mac profile across a different machine/network is a separate target;
this implementation cannot promise identical third-party risk decisions.

Google's [reCAPTCHA help](https://support.google.com/recaptcha/?hl=en) documents
challenge expiry and supported browser versions. Its
[unusual-traffic guidance](https://support.google.com/websearch/answer/86640?hl=en)
also identifies shared networks and automated traffic as possible factors for
Search challenges. These support keeping environment/history in the experiment;
they do not establish the reason for any specific rejection in this dataset.

## Reconnect resource regression found during final visual inspection

After receiver on/off testing, source Chrome retained its styled demo page, but
the Mac viewer showed a default-font, unstyled form. The receiver's in-memory
asset cache was gone; a new full snapshot referenced external stylesheets that
had loaded before the new receiver attached. The previous continuity fixture
used inline styling and did not cover this failure.

The expanded fixture reproduced the failure on the previous server. Recovery
now reads styles/images from Chrome's renderer resource store, including the
separate protocol clients for out-of-process frames. Font bytes and CSS background
images can be omitted from that store. For those, Chrome's own cache/loader is
used in the originating frame's context, only for URLs observed by Chrome.
Resource Timing is read in an isolated world so page scripts cannot replace
`performance.getEntriesByType` to fabricate the recovery allowlist. Arbitrary
viewer URLs, scripts, and repeated `<img>` challenge requests are not fetched by
this recovery path. Normal pending live resources still use the response relay.

The native-host regression passes on procbox and demobox for parent/child external
CSS and byte-identical CSS backgrounds, with no duplicate network request for the
cached fixture image. Unit coverage verifies scope checks, bounded streams and
cleanup, and deduplicated recovery for concurrent viewers. The actual Mac viewer
was then compared with a fresh source screenshot: the demo layout and reCAPTCHA
logo both recovered without source reload; procbox Chrome retained PID 3583403.
This fixes a reconnect defect, not the late CAPTCHA rejections in the V block,
which ran without receiver restarts.

## Original workflow and diagnostic input limitation

A fresh Google search for the original Artificial Analysis query loaded results
without a CAPTCHA after the fixes. A coordinate click through the actual Mac
viewer navigated the same remote tab to Artificial Analysis, verified both by
remote MCP state and the viewer. This is one successful workflow observation,
not an additional CAPTCHA pass-rate trial.

An extension semantic/AX click aimed directly at a link inside the **replay DOM**
bypassed the interaction overlay and navigated just the local replay iframe to a
blocked third-party frame. The remote source tab stayed on Google. Refreshing the
viewer recovered it; the subsequent coordinate click succeeded normally. Thus
semantic clicks into the replay DOM are not interchangeable with a human pointer
or source-side MCP action. This remains an accessibility/semantic-routing
limitation to address separately. T/V shared trials used coordinate input through
the interaction layer, so this failed semantic experiment is not silently mixed
into their CAPTCHA counts.

The private raw trial archive is retained on procbox at
`~/.local/state/dev-tools/shared-browser/diagnostics/captcha-2026-09-14/raw-observations.tar.gz`
(mode 0600, private parent directories). SHA-256:
`1b0b8d3491c1ef7727e48931f5d407d81fbdc8d2208c3f8b011837c2a2803964`.
Challenge images and resource URLs are deliberately excluded from Git; the
sanitized aggregate and ordered outcomes are committed with this report.
