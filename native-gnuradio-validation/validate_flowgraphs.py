#!/usr/bin/env python3
"""Compile and briefly execute GRC flowgraphs with native GNU Radio."""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
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


@dataclasses.dataclass(frozen=True)
class Result:
    path: Path
    status: str
    duration: float
    detail: str
    log: str


@dataclasses.dataclass(frozen=True)
class PreparedFlowgraph:
    path: Path
    replaced: int
    removed: int


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


def prepare_flowgraph(path: Path, output_dir: Path) -> PreparedFlowgraph:
    """Write a native-only copy with stream GUI sinks replaced by null sinks."""
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    blocks = data.get("blocks") or []
    connections = data.get("connections") or []
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

    remaining_qt_blocks = any(
        str(block.get("id", "")).startswith("qtgui_")
        for block in data.get("blocks") or []
    )
    options = data.get("options") or {}
    option_parameters = options.get("parameters") or {}
    if not remaining_qt_blocks and option_parameters.get("generate_options") == "qt_gui":
        option_parameters["generate_options"] = "no_gui"

    prepared_path = output_dir / path.name
    prepared_path.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    return PreparedFlowgraph(prepared_path, replaced, len(removed_names))


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


def validate_one(path: Path, root: Path, run_seconds: float, generate_only: bool) -> Result:
    started = time.monotonic()
    relative = path.relative_to(root)

    with tempfile.TemporaryDirectory(prefix="gr-native-") as temporary:
        output_dir = Path(temporary)
        home_dir = output_dir / "home"
        home_dir.mkdir()
        runtime_dir = output_dir / "runtime"
        runtime_dir.mkdir(mode=0o700)
        environment = os.environ.copy()
        environment.update(
            {
                "HOME": str(home_dir),
                "XDG_CACHE_HOME": str(home_dir / ".cache"),
                "XDG_CONFIG_HOME": str(home_dir / ".config"),
                "XDG_DATA_HOME": str(home_dir / ".local" / "share"),
                "XDG_RUNTIME_DIR": str(runtime_dir),
            }
        )
        try:
            prepared = prepare_flowgraph(path, output_dir)
        except (OSError, yaml.YAMLError, TypeError, ValueError) as error:
            return Result(
                relative,
                "PREPARE_FAIL",
                time.monotonic() - started,
                "could not replace GUI sinks",
                str(error),
            )
        preparation_detail = f"{prepared.replaced} GUI sink(s) replaced"
        if prepared.removed:
            preparation_detail += f", {prepared.removed} unconnected sink(s) removed"
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
                    "xvfb-run",
                    "--auto-servernum",
                    sys.executable,
                    str(program),
                ],
                cwd=path.parent,
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
                    "xvfb-run",
                    "--auto-servernum",
                    str(executable),
                ],
                cwd=path.parent,
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
    print(f"Validating {len(paths)} flowgraph(s) with {args.jobs} worker(s)\n")

    results: list[Result] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as executor:
        futures = {
            executor.submit(
                validate_one, path, root, args.run_seconds, args.generate_only
            ): path
            for path in paths
        }
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            results.append(result)
            print(f"{result.status:13} {result.path} ({result.duration:.1f}s) - {result.detail}")
            if result.log:
                print(result.log)
                print()

    results.sort(key=lambda result: str(result.path))
    failures = [result for result in results if result.status != "PASS"]
    print(f"\nSummary: {len(results) - len(failures)} passed, {len(failures)} failed, {len(results)} total")
    if failures:
        print("Failed flowgraphs:")
        for result in failures:
            print(f"  {result.status:13} {result.path}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
