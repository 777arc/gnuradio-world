# Native GNU Radio example validator

This directory is intentionally independent of the GNU Radio World editor,
runner, WebAssembly build, and Node test suites. It installs native GNU Radio in
an Ubuntu 26.04 container, compiles the repository's example flowgraphs with
`grcc`, and briefly executes every generated program under Xvfb. Python output
is syntax-checked; C++ output is configured and compiled with CMake first.

Before generation, the validator writes a temporary native-only copy of each
flowgraph. Stream-based `qtgui_*sink*` blocks become typed Null Sinks, including
their vector length and number of connected inputs. An unconnected GUI sink is
removed. When no Qt controls remain, the copy is also changed from `qt_gui` to
`no_gui`. The checked-in `.grc` files are never modified.

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
directories. The launcher returns nonzero if any flowgraph fails generation,
Python syntax checking, C++ compilation, startup, or logs an `ERROR`, `FATAL`,
or traceback.

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

Browser-only blocks, WebUSB hardware blocks, and out-of-tree modules that are
not present in Ubuntu's package are expected to be reported as failures. The
harness does not silently skip them, so its output is also an explicit native
compatibility report.

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
