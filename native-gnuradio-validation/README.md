# Native GNU Radio example validator

This directory is intentionally independent of the GNU Radio World editor,
runner, WebAssembly build, and Node test suites. It installs native GNU Radio in
an Ubuntu 26.04 container, compiles the repository's example flowgraphs with
`grcc`, and briefly executes every generated program under Xvfb. Python output
is syntax-checked; C++ output is configured and compiled with CMake first.

Before generation, the validator writes a temporary native-only copy of each
flowgraph. The checked-in `.grc` files are never modified. The copy differs from
the original in four ways:

- Stream-based `qtgui_*sink*` blocks become typed Null Sinks, including their
  vector length and number of connected inputs. An unconnected GUI sink is
  removed. When no Qt widget remains — sinks *or* controls such as QT GUI Range,
  which GRC refuses to generate in `no_gui` — the copy is also changed from
  `qt_gui` to `no_gui`.
- The GUI Layout block, which arranges the runner window and has no native
  equivalent, is dropped along with anything wired to it.
- The `import` blocks GRC builds its parameter-evaluation namespace from are
  added. GNU Radio World's editor resolves `math`, `numpy`, `firdes` and the
  GNU Radio namespaces itself and writes none, but native GRC evaluates a
  parameter only against what the flowgraph imports, so without them values
  like `math.pi` fail as undefined names. A flowgraph set to emit C++ is left
  alone, since the Import block is Python-only.

## The end-of-run report

After the per-flowgraph lines, the run prints a summary counting passes,
failures and skips, then lists the failed and the skipped flowgraphs with the
reason for each. A failure gets two lines — the step that failed (`grcc exited
1`) and what actually went wrong, lifted out of its log (`Flowgraph invalid:
Param - Sample Rate(samp_rate): Value "nonexistent_rate" cannot be evaluated
...`, or a Python program's exception). A skip is listed with the blocks that
caused it. The report therefore stands on its own once the interleaved logs
have scrolled past.

## Skipped flowgraphs

A flowgraph that still contains a block this GNU Radio does not have is
**skipped**, not failed — a vendored out-of-tree module Ubuntu does not package
(gr-satellites, gr-rds, gr-paint, …) or one of GNU Radio World's own
browser-only blocks (the WebUSB hardware sources, the recording sources, the
JavaScript Block). The summary lists them with the blocks responsible, so the
run is still an explicit native-compatibility report, but the exit status
reflects only flowgraphs native GNU Radio could actually have run.

## Run it

Docker is the only host dependency:

```bash
./native-gnuradio-validation/run.sh
```

The same check is available from GitHub Actions as **Native GNU Radio
Examples**. It uses only `workflow_dispatch`, so it must be started manually
from the Actions tab and never runs on pushes, pull requests, or a schedule.

The launcher builds the image and bind-mounts `example_flowgraphs/` read-only.
Generated programs, builds, and Python bytecode stay in temporary container
directories, and each program runs in a writable one of its own so a File Sink
writing a relative path can open it. The launcher returns nonzero if any
flowgraph fails generation, Python syntax checking, C++ compilation, startup, or
logs an `ERROR`, `FATAL`, or traceback.

One Xvfb serves the whole run. (`xvfb-run --auto-servernum` picks a display per
invocation and concurrent workers race for the same number, which kills the
loser's Qt program with "The X11 connection broke".) A null ALSA device is
configured too, so Audio Sink and Audio Source can be exercised in a container
with no sound card.

Most GNU Radio flowgraphs run until stopped. A graph that is still healthy after
three seconds is terminated and counted as passing. Change the runtime window or
concurrency when needed:

```bash
./native-gnuradio-validation/run.sh --run-seconds 10 --jobs 2
```

Validate selected files or only test native generation:

```bash
./native-gnuradio-validation/run.sh blocks/simple_copy.grc 'analog/*.grc'
./native-gnuradio-validation/run.sh --generate-only
```

## GNU Radio version

The Dockerfile follows the requested installation path:

```bash
sudo apt-get install -y gnuradio
```

That installs Ubuntu 26.04's packaged GNU Radio and prints its exact version at
the start of each run. It is not a source build of the `main` branch from
`github.com/gnuradio/gnuradio`; APT packages immutable release snapshots. If the
test target must literally be the latest upstream `main` commit, it needs a
separate source-build image rather than `apt install gnuradio`.
