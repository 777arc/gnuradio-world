#!/usr/bin/env python3
"""Compile and briefly execute GRC flowgraphs with native GNU Radio."""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import dataclasses
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import time

import yaml


ERROR_PATTERN = re.compile(
    r"(^|\n)(Traceback \(most recent call last\):|[^\n]*\b(?:ERROR|FATAL)\b)",
    re.IGNORECASE,
)

FLOAT_GUI_SINKS = {
    "qtgui_eye_sink_x",
    "qtgui_histogram_sink_x",
    "qtgui_matrix_sink",
    "qtgui_number_sink",
    "qtgui_vector_sink_f",
}

# GNU Radio World arranges the runner window with a singleton block holding a
# `block ID -> [col, row, w, h]` grid.  It carries no DSP and never connects to
# anything, and native GNU Radio has no equivalent, so the native-only copy
# simply drops it rather than being skipped over it.
LAYOUT_ONLY_BLOCKS = {"wasm_gui_layout"}

# Statements that populate the namespace GRC evaluates parameters in.  Native
# flowgraphs carry these as `import` blocks; GNU Radio World's editor resolves
# the same names internally and writes none, so the native-only copy adds them.
# An unused import costs an unused line in the generated program and nothing
# else, so the set is deliberately generous rather than derived per flowgraph.
NAMESPACE_IMPORTS = (
    "import math",
    "import cmath",
    "import numpy",
    "import pmt",
    "from gnuradio import gr",
    "from gnuradio import analog",
    "from gnuradio import blocks",
    "from gnuradio import channels",
    "from gnuradio import digital",
    "from gnuradio import fft",
    "from gnuradio import filter",
    "from gnuradio.fft import window",
    "from gnuradio.filter import firdes",
)

# Qt widgets that are not sinks: GRC refuses to generate them in `no_gui` mode,
# so their presence keeps the copy on the `qt_gui` workflow even after every
# stream sink has become a Null Sink.
QT_WIDGET_PREFIXES = ("qtgui_", "variable_qtgui_")


@dataclasses.dataclass(frozen=True)
class Result:
    path: Path
    status: str
    duration: float
    detail: str
    log: str
    # The end-of-run report's one-line "why".  Defaults to `detail`, which for a
    # failure already is the reason ("grcc exited 1"); a skip overrides it with
    # the bare block list, since its header carries the explanation.
    reason: str = ""

    def why(self) -> str:
        return self.reason or self.detail


@dataclasses.dataclass(frozen=True)
class PreparedFlowgraph:
    path: Path
    replaced: int
    removed: int
    dropped: int
    imported: int
    unsupported: tuple

    def describe(self) -> str:
        parts = [f"{self.replaced} GUI sink(s) replaced"]
        if self.removed:
            parts.append(f"{self.removed} unconnected sink(s) removed")
        if self.dropped:
            parts.append(f"{self.dropped} layout block(s) dropped")
        if self.imported:
            parts.append(f"{self.imported} import block(s) added")
        return ", ".join(parts)


def is_gui_sink(block: dict) -> bool:
    block_id = str(block.get("id", ""))
    return block_id.startswith("qtgui_") and "sink" in block_id


def null_sink_type(block: dict) -> str:
    parameters = block.get("parameters") or {}
    block_type = str(parameters.get("type", ""))
    if block_type.startswith("msg_"):
        block_type = block_type.removeprefix("msg_")
    if block_type in {"complex", "float", "int", "short", "byte"}:
        return block_type
    if block.get("id") in FLOAT_GUI_SINKS:
        return "float"
    return "complex"


def _touches(connection, names: set) -> bool:
    """Whether a connection names one of `names` at either end."""
    if isinstance(connection, list) and len(connection) >= 4:
        return str(connection[0]) in names or str(connection[2]) in names
    if isinstance(connection, dict):
        return (str(connection.get("src_blk_id", "")) in names
                or str(connection.get("snk_blk_id", "")) in names)
    return False


def add_namespace_imports(data: dict) -> int:
    """Add the `import` blocks GRC builds its evaluation namespace from.

    GNU Radio World's editor knows `math`, `numpy`, `firdes` and the GNU Radio
    namespaces itself and writes no import blocks, but native GRC evaluates a
    parameter only against what the flowgraph imports.  Without these, values
    like `math.pi` or `firdes.window(...)` fail as undefined names.

    The Import block is Python-only (`flags: [python]`), so a flowgraph set to
    emit C++ is left alone -- GRC refuses to generate one there.
    """
    options = (data.get("options") or {}).get("parameters") or {}
    if str(options.get("output_language", "python")) not in ("", "python"):
        return 0
    blocks = data.get("blocks") or []
    present = {
        str((block.get("parameters") or {}).get("imports", "")).strip()
        for block in blocks
        if str(block.get("id", "")) in {"import", "import_"}
    }
    taken = {str(block.get("name", "")) for block in blocks}
    added = []
    for index, statement in enumerate(NAMESPACE_IMPORTS):
        if statement in present:
            continue
        name = f"native_import_{index}"
        while name in taken:
            name += "_"
        taken.add(name)
        added.append({
            "name": name,
            "id": "import",
            "parameters": {"alias": "", "comment": "", "imports": statement},
            "states": {
                "coordinate": [8, 8 + 8 * index],
                "rotation": 0,
                "state": "enabled",
            },
        })
    data["blocks"] = added + blocks
    return len(added)


def native_block_ids() -> frozenset:
    """Every block id this GNU Radio installation can generate.

    Used to skip a flowgraph built on blocks the installation does not have --
    a vendored out-of-tree module, or one of GNU Radio World's own browser-only
    blocks -- rather than reporting it as a failure.
    """
    from gnuradio import gr
    from gnuradio.grc.core.platform import Platform

    platform = Platform(
        name="native-validator",
        prefs=gr.prefs(),
        version=gr.version(),
        version_parts=(gr.major_version(), gr.api_version(), gr.minor_version()),
    )
    platform.build_library()
    return frozenset(platform.blocks.keys())


def prepare_flowgraph(
    path: Path, output_dir: Path, known_block_ids: frozenset
) -> PreparedFlowgraph:
    """Write a native-only copy of the flowgraph.

    Stream GUI sinks become typed Null Sinks, the GUI Layout block is dropped,
    and the import blocks native GRC evaluates parameters against are added.
    Any block native GNU Radio still does not know is reported back so the
    caller can skip the flowgraph rather than fail it.
    """
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    blocks = data.get("blocks") or []
    connections = data.get("connections") or []

    # Browser-only layout metadata: drop it and anything wired to it.
    layout_names = {
        str(block.get("name", ""))
        for block in blocks
        if str(block.get("id", "")) in LAYOUT_ONLY_BLOCKS
    }
    if layout_names:
        blocks = [
            block
            for block in blocks
            if str(block.get("name", "")) not in layout_names
        ]
        connections = [
            connection
            for connection in connections
            if not _touches(connection, layout_names)
        ]
        data["blocks"] = blocks
        data["connections"] = connections
    replacement_ports: dict[str, dict[str, str]] = {}
    removed_names: set[str] = set()
    replaced = 0

    for block in blocks:
        if not is_gui_sink(block):
            continue
        name = str(block.get("name", ""))
        incoming = [
            connection
            for connection in connections
            if isinstance(connection, list)
            and len(connection) >= 4
            and str(connection[2]) == name
        ]
        if not incoming:
            removed_names.add(name)
            continue

        ports = sorted(
            {str(connection[3]) for connection in incoming},
            key=lambda value: (not value.isdigit(), int(value) if value.isdigit() else value),
        )
        replacement_ports[name] = {
            original: str(index) for index, original in enumerate(ports)
        }
        old_parameters = block.get("parameters") or {}
        input_type = null_sink_type(block)
        block["id"] = "blocks_null_sink"
        block["parameters"] = {
            "type": input_type,
            "vlen": str(old_parameters.get("vlen", "1")),
            "num_inputs": str(len(ports)),
        }
        replaced += 1

    if removed_names:
        data["blocks"] = [
            block for block in blocks if str(block.get("name", "")) not in removed_names
        ]

    rewritten_connections: list = []
    for connection in connections:
        if isinstance(connection, list) and len(connection) >= 4:
            source_name = str(connection[0])
            sink_name = str(connection[2])
            if source_name in removed_names or sink_name in removed_names:
                continue
            if sink_name in replacement_ports:
                connection[3] = replacement_ports[sink_name][str(connection[3])]
        elif isinstance(connection, dict):
            source_name = str(connection.get("src_blk_id", ""))
            sink_name = str(connection.get("snk_blk_id", ""))
            if (
                source_name in removed_names
                or sink_name in removed_names
                or source_name in replacement_ports
                or sink_name in replacement_ports
            ):
                continue
        rewritten_connections.append(connection)
    data["connections"] = rewritten_connections

    # Qt *controls* (QT GUI Range and friends) are `variable_qtgui_*`, not
    # `qtgui_*`.  Missing them here would switch a flowgraph that still has a
    # slider to `no_gui`, which GRC refuses to generate.
    remaining_qt_blocks = any(
        str(block.get("id", "")).startswith(QT_WIDGET_PREFIXES)
        for block in data.get("blocks") or []
    )
    options = data.get("options") or {}
    option_parameters = options.get("parameters") or {}
    if not remaining_qt_blocks and option_parameters.get("generate_options") == "qt_gui":
        option_parameters["generate_options"] = "no_gui"

    imported = add_namespace_imports(data)

    unsupported = tuple(sorted({
        str(block.get("id", ""))
        for block in data.get("blocks") or []
        if str(block.get("id", "")) not in known_block_ids
    }))

    prepared_path = output_dir / path.name
    prepared_path.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    return PreparedFlowgraph(
        prepared_path, replaced, len(removed_names), len(layout_names),
        imported, unsupported,
    )


def command_output(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            check=False,
        )
    except OSError as error:
        return 127, f"could not execute {command[0]}: {error}"
    return completed.returncode, completed.stdout


def trim_log(log: str, limit: int = 60) -> str:
    lines = [line.rstrip() for line in log.splitlines()]
    if len(lines) <= limit:
        return "\n".join(lines)
    omitted = len(lines) - limit
    return "\n".join([*lines[: limit // 2], f"... {omitted} lines omitted ...", *lines[-limit // 2 :]])


def validate_one(
    path: Path,
    root: Path,
    run_seconds: float,
    generate_only: bool,
    known_block_ids: frozenset,
    display: str,
) -> Result:
    started = time.monotonic()
    relative = path.relative_to(root)

    with tempfile.TemporaryDirectory(prefix="gr-native-") as temporary:
        output_dir = Path(temporary)
        home_dir = output_dir / "home"
        home_dir.mkdir()
        runtime_dir = output_dir / "runtime"
        runtime_dir.mkdir(mode=0o700)
        # Generated programs run here rather than beside the .grc: the flowgraph
        # directory is mounted read-only, and a File Sink writing a relative path
        # ("atsc.cfile") fails to open there.
        work_dir = output_dir / "run"
        work_dir.mkdir()
        # There is no sound card in a container, and gr-audio's ALSA sink throws
        # out of its constructor when it cannot open one. A null default device
        # lets Audio Sink/Source be exercised like any other block.
        (home_dir / ".asoundrc").write_text(
            "pcm.!default { type null }\nctl.!default { type null }\n",
            encoding="utf-8",
        )
        environment = os.environ.copy()
        environment.update(
            {
                "HOME": str(home_dir),
                "XDG_CACHE_HOME": str(home_dir / ".cache"),
                "XDG_CONFIG_HOME": str(home_dir / ".config"),
                "XDG_DATA_HOME": str(home_dir / ".local" / "share"),
                "XDG_RUNTIME_DIR": str(runtime_dir),
                "DISPLAY": display,
            }
        )
        try:
            prepared = prepare_flowgraph(path, output_dir, known_block_ids)
        except (OSError, yaml.YAMLError, TypeError, ValueError) as error:
            return Result(
                relative,
                "PREPARE_FAIL",
                time.monotonic() - started,
                "could not replace GUI sinks",
                str(error),
            )
        # A flowgraph built on blocks this installation does not have is out of
        # scope rather than broken: a vendored out-of-tree module Ubuntu does
        # not package, or one of GNU Radio World's own browser-only blocks.
        if prepared.unsupported:
            return Result(
                relative,
                "SKIP",
                time.monotonic() - started,
                "block(s) not in this GNU Radio: " + ", ".join(prepared.unsupported),
                "",
                ", ".join(prepared.unsupported),
            )
        preparation_detail = prepared.describe()
        generate_code, generate_log = command_output(
            ["grcc", "--output", str(output_dir), str(prepared.path)],
            cwd=path.parent,
            env=environment,
        )
        python_programs = sorted(output_dir.glob("*.py"))
        cpp_projects = sorted(
            path.parent for path in output_dir.glob("*/CMakeLists.txt")
        )
        if generate_code != 0 or not (python_programs or cpp_projects):
            reason = (
                f"grcc exited {generate_code}"
                if generate_code
                else "grcc generated no runnable Python or C++ program"
            )
            return Result(relative, "GENERATE_FAIL", time.monotonic() - started, reason, trim_log(generate_log))

        for program in python_programs:
            syntax_code, syntax_log = command_output(
                [sys.executable, "-m", "py_compile", str(program)],
                cwd=path.parent,
                env=environment,
            )
            if syntax_code != 0:
                return Result(
                    relative,
                    "SYNTAX_FAIL",
                    time.monotonic() - started,
                    f"generated {program.name} did not compile",
                    trim_log(generate_log + "\n" + syntax_log),
                )

        if generate_only:
            detail = "generated"
            if python_programs:
                detail += " and syntax-checked"
            detail += f"; {preparation_detail}"
            return Result(relative, "PASS", time.monotonic() - started, detail, "")

        # A top-level GRC flowgraph normally yields exactly one Python program.
        # If it yields more, running each catches imports and initialization
        # failures without making assumptions about the generated filename.
        run_logs: list[str] = []
        for program in python_programs:
            run_code, run_log = command_output(
                [
                    "timeout",
                    "--signal=TERM",
                    "--kill-after=2s",
                    f"{run_seconds}s",
                    sys.executable,
                    str(program),
                ],
                cwd=work_dir,
                env=environment,
            )
            run_logs.append(f"--- {program.name} ---\n{run_log}")

            # timeout returns 124 after TERM and 137 if KILL was needed.  Both
            # mean the long-running graph stayed alive for the validation window.
            if run_code not in (0, 124, 137):
                return Result(
                    relative,
                    "RUN_FAIL",
                    time.monotonic() - started,
                    f"{program.name} exited {run_code}",
                    trim_log(generate_log + "\n" + "\n".join(run_logs)),
                )
            if ERROR_PATTERN.search(run_log):
                return Result(
                    relative,
                    "RUN_FAIL",
                    time.monotonic() - started,
                    f"{program.name} logged an error",
                    trim_log(generate_log + "\n" + "\n".join(run_logs)),
                )

        for project in cpp_projects:
            build_dir = project / "build"
            configure_code, configure_log = command_output(
                [
                    "cmake",
                    "-S",
                    str(project),
                    "-B",
                    str(build_dir),
                    "-DCMAKE_BUILD_TYPE=Release",
                ],
                cwd=path.parent,
                env=environment,
            )
            if configure_code != 0:
                return Result(
                    relative,
                    "BUILD_FAIL",
                    time.monotonic() - started,
                    f"CMake configuration exited {configure_code}",
                    trim_log(generate_log + "\n" + configure_log),
                )

            build_code, build_log = command_output(
                ["cmake", "--build", str(build_dir), "--parallel", "2"],
                cwd=path.parent,
                env=environment,
            )
            if build_code != 0:
                return Result(
                    relative,
                    "BUILD_FAIL",
                    time.monotonic() - started,
                    f"C++ build exited {build_code}",
                    trim_log(generate_log + "\n" + configure_log + "\n" + build_log),
                )

            executable = build_dir / project.name
            if not executable.is_file():
                return Result(
                    relative,
                    "BUILD_FAIL",
                    time.monotonic() - started,
                    f"C++ build did not create {executable.name}",
                    trim_log(generate_log + "\n" + configure_log + "\n" + build_log),
                )

            run_code, run_log = command_output(
                [
                    "timeout",
                    "--signal=TERM",
                    "--kill-after=2s",
                    f"{run_seconds}s",
                    str(executable),
                ],
                cwd=work_dir,
                env=environment,
            )
            if run_code not in (0, 124, 137) or ERROR_PATTERN.search(run_log):
                reason = (
                    f"{executable.name} logged an error"
                    if ERROR_PATTERN.search(run_log)
                    else f"{executable.name} exited {run_code}"
                )
                return Result(
                    relative,
                    "RUN_FAIL",
                    time.monotonic() - started,
                    reason,
                    trim_log(
                        generate_log
                        + "\n"
                        + configure_log
                        + "\n"
                        + build_log
                        + "\n"
                        + run_log
                    ),
                )

        return Result(
            relative,
            "PASS",
            time.monotonic() - started,
            f"ran for up to {run_seconds:g}s; {preparation_detail}",
            "",
        )


@contextlib.contextmanager
def shared_display(number: int = 99):
    """Run one Xvfb for the whole validation and point every child at it.

    `xvfb-run --auto-servernum` picks a display number per invocation, and
    concurrent workers race for the same one -- the loser's Qt program dies
    with "The X11 connection broke".  One server started up front removes the
    race and is torn down here whatever happens.
    """
    display = f":{number}"
    server = subprocess.Popen(
        ["Xvfb", display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # Give the server a moment to create its socket before the first client.
        for _ in range(100):
            if os.path.exists(f"/tmp/.X11-unix/X{number}"):
                break
            if server.poll() is not None:
                raise RuntimeError(f"Xvfb exited with {server.returncode}")
            time.sleep(0.05)
        else:
            raise RuntimeError("Xvfb did not start within five seconds")
        yield display
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


def failure_cause(log: str) -> str:
    """The most informative line in a failure's log, for the summary report.

    A failure's `detail` says which step failed ("grcc exited 1"); this says
    what actually went wrong, so the report stands on its own once the
    interleaved per-flowgraph logs have scrolled past.
    """
    raw = [line for line in log.splitlines() if line.strip()]
    lines = [line.strip() for line in raw]

    # A Python traceback's last line is the exception, which is the whole story.
    for index in range(len(lines) - 1, -1, -1):
        if re.match(r"^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt): \S", lines[index]):
            return lines[index]

    # GRC's own load failure, plus the first parameter or block it names. GRC
    # writes the heading and its message on separate lines, the message indented
    # under it, so gather the continuation as well.
    load_error = next(
        (re.sub(r"^>>> Load Error: \S+: ", "", line)
         for line in lines if line.startswith(">>> Load Error:")),
        "",
    )
    detail = ""
    for index, line in enumerate(lines):
        if not line.startswith(("Param - ", "Block - ")):
            continue
        parts = [line]
        for follower_raw, follower in zip(raw[index + 1:], lines[index + 1:]):
            if not follower_raw[:1].isspace():
                break
            parts.append(follower)
        # GRC runs consecutive errors together without a separator
        # ("...is not definedParam - Waveform(waveform):"), so keep the first.
        detail = re.split(r"(?<=\S)(?=Param - |Block - )", " ".join(parts))[0].strip()
        break
    if load_error and detail:
        return f"{load_error}: {detail}"
    if load_error:
        return load_error

    return next((line for line in lines if ERROR_PATTERN.search(line)), "")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate and briefly run .grc files using Ubuntu's native GNU Radio package."
    )
    parser.add_argument("root", type=Path, help="directory containing example flowgraphs")
    parser.add_argument(
        "patterns",
        nargs="*",
        help="optional paths or glob patterns relative to ROOT (default: every .grc recursively)",
    )
    parser.add_argument(
        "--run-seconds",
        type=float,
        default=3.0,
        metavar="SECONDS",
        help="successful runtime window for each generated program (default: 3)",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=min(4, os.cpu_count() or 1),
        help="number of flowgraphs to validate concurrently (default: up to 4)",
    )
    parser.add_argument(
        "--generate-only",
        action="store_true",
        help="stop after grcc generation and Python syntax checking",
    )
    return parser.parse_args()


def discover(root: Path, patterns: list[str]) -> list[Path]:
    if not patterns:
        candidates = root.rglob("*.grc")
    else:
        expanded: list[Path] = []
        for pattern in patterns:
            matches = list(root.glob(pattern))
            if not matches:
                raise ValueError(f"pattern matched no files: {pattern}")
            expanded.extend(matches)
        candidates = iter(expanded)

    return sorted(
        {path.resolve() for path in candidates if path.is_file() and path.suffix == ".grc"},
        key=lambda path: str(path.relative_to(root)),
    )


def version_summary() -> str:
    commands = (
        ["gnuradio-config-info", "--version"],
        [sys.executable, "-c", "from gnuradio import gr; print(gr.version())"],
    )
    for command in commands:
        code, output = command_output(command)
        if code == 0 and output.strip():
            return output.strip().splitlines()[-1]
    return "unknown"


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        print(f"error: flowgraph directory does not exist: {root}", file=sys.stderr)
        return 2
    if args.run_seconds <= 0:
        print("error: --run-seconds must be greater than zero", file=sys.stderr)
        return 2
    if args.jobs <= 0:
        print("error: --jobs must be greater than zero", file=sys.stderr)
        return 2

    try:
        paths = discover(root, args.patterns)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    if not paths:
        print(f"error: no .grc files found below {root}", file=sys.stderr)
        return 2

    print(f"GNU Radio {version_summary()}")
    try:
        known_block_ids = native_block_ids()
    except Exception as error:  # noqa: BLE001 - report rather than traceback
        print(f"error: could not read the GNU Radio block library: {error}",
              file=sys.stderr)
        return 2
    print(f"Validating {len(paths)} flowgraph(s) with {args.jobs} worker(s)")
    print(f"{len(known_block_ids)} block(s) available natively\n")

    results: list[Result] = []
    # A generated program is only executed when it is actually run; generation
    # alone needs no display.
    display_context = (
        contextlib.nullcontext(os.environ.get("DISPLAY", ":99"))
        if args.generate_only else shared_display()
    )
    try:
        with display_context as display:
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as executor:
                futures = {
                    executor.submit(
                        validate_one, path, root, args.run_seconds,
                        args.generate_only, known_block_ids, display,
                    ): path
                    for path in paths
                }
                for future in concurrent.futures.as_completed(futures):
                    result = future.result()
                    results.append(result)
                    print(f"{result.status:13} {result.path} "
                          f"({result.duration:.1f}s) - {result.detail}")
                    if result.log:
                        print(result.log)
                        print()
    except (OSError, RuntimeError) as error:
        print(f"error: could not start the X server: {error}", file=sys.stderr)
        return 2

    results.sort(key=lambda result: str(result.path))
    skipped = [result for result in results if result.status == "SKIP"]
    failures = [result for result in results
                if result.status not in ("PASS", "SKIP")]
    passed = len(results) - len(failures) - len(skipped)
    print(f"\nSummary: {passed} passed, {len(failures)} failed, "
          f"{len(skipped)} skipped, {len(results)} total")

    # Both lists carry their reason: a run whose log has scrolled past should
    # still say what failed, what was never attempted, and why in each case.
    if failures:
        print(f"\nFailed ({len(failures)}):")
        for result in failures:
            print(f"  {result.status:13} {result.path}")
            print(f"  {'':13} {result.why()}")
            cause = failure_cause(result.log)
            if cause:
                print(f"  {'':13} {textwrap.shorten(cause, width=200)}")
    if skipped:
        print(f"\nSkipped ({len(skipped)}) -- blocks this GNU Radio does not "
              "have, so the flowgraph was never generated or run:")
        for result in skipped:
            print(f"  {result.path}")
            print(f"  {'':13} {result.why()}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
