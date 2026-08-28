#!/usr/bin/env python3
"""Generate JSON-to-C++ factories for GRC blocks with direct C++ templates.

The browser cannot run GRC's Python generator, so its runtime needs an ahead-of-
time factory for every direct C++ block.  This script renders the same
``cpp_templates`` used by GRC, replacing parameters with typed JSON readers.
Hand-written factories remain available for blocks that need QWidget ownership,
live setters, or are Python/hierarchical compositions.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml
from mako.template import Template


WORLD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORLD / "tools"))
import block_overrides  # noqa: E402  (needs WORLD on the path first)

GR = Path(os.environ.get("GR", WORLD / "gnuradio")).resolve()
MODULE_CONFIG = json.loads((Path(__file__).with_name("modules.json")).read_text())
MODULE_SOURCE_ROOTS = {
    module: WORLD / relative
    for module, relative in MODULE_CONFIG.get("source_roots", {}).items()
}

# Block categories whose C++ is statically linked into the main runner module and
# always available. Everything else is compiled into a per-module WebAssembly side
# module that is fetched on demand the first time a flowgraph uses one of its
# blocks (see the runner's dlopen loader and CMakeLists side-module targets).
CORE_MODULES = tuple(MODULE_CONFIG["core"])
DEFERRED_MODULES = tuple(MODULE_CONFIG["deferred"])
MODULES = tuple(f"gr-{module}" for module in (*CORE_MODULES, *DEFERRED_MODULES))

# Load-order dependencies between DEFERRED modules only (core is always present).
# gr-satellites' rebuilt Python hierarchies wrap their message ports with
# gr::pdu::{pdu_to_tagged_stream,tagged_stream_to_pdu}, which live in the pdu
# side module, so pdu.wasm has to be loaded first for those imports to resolve.
MODULE_DEPS: dict[str, list[str]] = MODULE_CONFIG["module_deps"]

# Browser-only block metadata kept in this repository so every submodule can stay
# pinned to a pristine upstream commit: one directory per module under
# blocks/overlays/, each holding that module's metadata.yml.
# The editor's palette generator applies the same overlays through the same
# module, so a block's runtime factory and its palette entry cannot disagree.
BLOCK_OVERRIDES: dict[str, dict[str, Any]] = block_overrides.load()

# These have direct C++ flags, but their constructor takes another GRC variable
# object.  Supporting them requires a typed object registry, not a block factory.
OBJECT_PARAMETERS = {
    ("digital_protocol_formatter_async", "format"),
    ("digital_protocol_formatter_bb", "format"),
    ("digital_ofdm_frame_equalizer_vcvc", "equalizer"),
    ("digital_protocol_parser_b", "format"),
    ("digital_framer_sink_1", "target_queue"),
    ("digital_ofdm_carrier_allocator_cvc", "occupied_carriers"),
    ("digital_packet_headergenerator_bb", "header_formatter"),
    ("digital_packet_sink", "target_queue"),
    ("digital_ofdm_serializer_vcc", "occupied_carriers"),
}

# Every hand-written factory in registry.cpp, read back out of the table itself.
# A custom factory is one providing a widget, live callbacks, or a browser-safe
# implementation, and the generator must not emit a duplicate of it.
def read_custom_factory_ids() -> set[str]:
    """The block ids registry.cpp's hand-written factory table registers.

    Parsed rather than restated here.  That table is the only place deciding
    which ids have a hand-written factory, so a second copy in this file could
    only ever drift from it -- and the drift is silent in the harmless
    direction and a duplicate-symbol link error in the other.  Whatever a
    factory is for is documented above the factory, where the code is.

    The delimiters are the map's own declaration and the comment closing it, so
    a `{"id",` appearing anywhere else in registry.cpp -- in a helper, or in the
    generated-factory merge below the table -- is not mistaken for an entry.
    """
    source = (WORLD / "runner" / "src" / "registry.cpp").read_text()
    try:
        table = source.split(
            "const std::map<std::string, Factory> custom = {", 1)[1].split(
            "      // Custom factories intentionally win", 1)[0]
    except IndexError as error:
        raise SystemExit(
            "could not locate the custom factory table in registry.cpp") from error
    ids = set(re.findall(r'^        \{"([^"]+)",', table, re.MULTILINE))
    if not ids:
        raise SystemExit("registry.cpp's custom factory table parsed as empty")
    return ids


CUSTOM_IDS = read_custom_factory_ids()

# Blocks whose factory returns a QWidget, i.e. everything that occupies a tile in
# the runner window. The editor needs this to lay a flowgraph out *before* it has
# ever been run, which is the one question it cannot answer for itself: whether a
# BuiltBlock carries a widget is decided in C++, by the hand-written factories in
# registry.cpp. It reaches the palette as each block's `gui` flag, by way of the
# generated_blocks.json manifest.
#
# The fact is declared per block rather than listed here, so that adding a
# widget-bearing block does not also mean remembering to edit this file: a
# runner-only block says `gui: true` in its own blocks/grc/<id>.block.yml, and an
# upstream one says it in its module's overlay, which is where every other
# browser-only fact about that block already lives. validate() rejects the
# declaration on a block with no hand-written factory, and the runner reports the
# widgets it actually built on every run, so the editor can name in the console
# anything that builds a widget without having said so.
def read_gui_ids() -> set[str]:
    """Block ids declaring `gui: true`, from the two places one can be declared."""
    ids = {block_id for block_id, override in BLOCK_OVERRIDES.items()
           if override.get("gui")}
    for path in sorted((WORLD / "blocks" / "grc").glob("*.block.yml")):
        try:
            block = yaml.safe_load(path.read_text())
        except Exception:
            continue
        if isinstance(block, dict) and block.get("gui") and "id" in block:
            ids.add(str(block["id"]))
    return ids


GUI_IDS = read_gui_ids()

INVALID_CPP_TEMPLATES = {
    # Not present in the WASM static libraries because their optional native
    # dependencies/features (CtrlPort or libsndfile) are disabled.
    "blocks_ctrlport_probe2_x",
    "blocks_ctrlport_probe2_c",
    "blocks_ctrlport_probe_c",
    "blocks_wavfile_sink",
    "blocks_wavfile_source",
    "fft_ctrlport_probe_psd",
    # These optional codecs were not built because their native libraries are
    # absent from the WASM sysroot.
    "vocoder_codec2_decode_ps",
    "vocoder_codec2_encode_sp",
    "vocoder_gsm_fr_decode_ps",
    "vocoder_gsm_fr_encode_sp",
}

# Blocks whose C++ builds and links perfectly well, but which are deliberately
# not offered in the browser. Unlike INVALID_CPP_TEMPLATES above -- a build
# constraint -- this is a judgement about the runtime, so each entry carries the
# reason the palette shows on hover. They stay visible and greyed out, exactly
# like a Python-only block.
EXCLUDED_BLOCKS: dict[str, str] = {
    # Fed anything noise-like it false-triggers on its syncword constantly and
    # runs a full frame decode on each hit, which saturates the browser's main
    # thread: the tab stops responding entirely at 200 kS/s, while the same
    # graph at 2 kS/s finishes in under a second. Dropping syncword_threshold
    # from 4 to 0 also clears it, which is what identifies the search as the
    # hot path rather than the Reed-Solomon decode several other deframers
    # share. The C++ rebuild in blocks/overlays/gr-satellites/ is kept, so this
    # is one line to undo if the cost is ever tracked down.
    "satellites_sat_3cat_1_deframer":
        "too computationally intensive for the browser runtime: it saturates "
        "the main thread and stops the page responding",
    # Upstream's two SigMF blocks are Python, and both are flagged deprecated
    # there. The source is a File Source whose documentation tells you to open
    # the .sigmf-meta in a text editor and set the datatype by hand; the browser
    # blocks below read it for themselves and turn its captures and annotations
    # into stream tags. Excluding these keeps them visible and greyed out with
    # this reason on hover, rather than looking merely broken.
    "blocks_sigmf_source_minimal":
        "use SigMF Source instead: it reads the .sigmf-meta for itself and "
        "turns the recording's captures and annotations into stream tags",
    "blocks_sigmf_sink_minimal":
        "use SigMF Sink instead: it writes both halves of the recording and "
        "turns the flowgraph's stream tags into annotations",
}


def validate_configuration() -> None:
    """Keep the cross-language module and custom-factory manifests honest."""
    core = list(CORE_MODULES)
    deferred = list(DEFERRED_MODULES)
    if len(set(core)) != len(core) or len(set(deferred)) != len(deferred):
        raise SystemExit("runner/modules.json contains duplicate module names")
    overlap = sorted(set(core) & set(deferred))
    if overlap:
        raise SystemExit(f"runner/modules.json marks modules core and deferred: {overlap}")
    known_deferred = set(deferred)
    unknown_roots = sorted(set(MODULE_SOURCE_ROOTS) - set(MODULES))
    if unknown_roots:
        raise SystemExit(
            f"runner/modules.json has source roots for unknown modules: {unknown_roots}")
    for module, dependencies in MODULE_DEPS.items():
        unknown = sorted(({module, *dependencies}) - known_deferred)
        if unknown:
            raise SystemExit(
                f"runner/modules.json has unknown deferred dependency names: {unknown}")

    # Only a hand-written factory ever builds a QWidget, so a block declaring
    # `gui: true` without one is a typo -- and a typo here costs that block its
    # tile in the runner window with no other symptom.
    not_custom = sorted(GUI_IDS - CUSTOM_IDS)
    if not_custom:
        raise SystemExit(
            "blocks declare `gui: true` but have no hand-written factory: "
            + ", ".join(not_custom))


def cpp_atom(value: Any) -> str:
    """Translate a scalar GRC/Python spelling to its C++ spelling."""
    if value is None:
        return "{}"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    value = str(value).strip()
    if value in {"True", "true"}:
        return "true"
    if value in {"False", "false"}:
        return "false"
    if value in {"None", "pmt.PMT_NIL"}:
        return "pmt::PMT_NIL"
    if (len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'"):
        return json.dumps(value[1:-1])
    value = value.replace("gr.types.", "gr::types::")
    value = re.sub(r"\bgr\.sizeof_gr_complex\b", "sizeof(gr_complex)", value)
    value = re.sub(r"\bgr\.sizeof_(float|int|short|char)\b", r"sizeof(\1)", value)
    value = value.replace("pmt.", "pmt::")
    value = re.sub(r"\bgr\.(DISP[A-Z0-9_]+)\b", r"\1", value)
    for namespace in ("gr", "blocks", "analog", "fft", "filter", "digital", "dtv"):
        value = re.sub(rf"\b{namespace}\.", namespace + "::", value)
    return value


def fallback(dtype: str, default: Any) -> str:
    value = "" if default is None else str(default).strip()
    if dtype in {"int", "hex"}:
        try:
            return str(int(value, 0))
        except (TypeError, ValueError):
            return "0"
    if dtype in {"real", "float"}:
        try:
            return repr(float(value))
        except (TypeError, ValueError):
            return "0.0"
    if dtype == "bool":
        return "true" if value.lower() in {"true", "1", "yes", "on"} else "false"
    if dtype in {"string", "file_open", "file_save", "dir_select"}:
        return json.dumps(value[1:-1] if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'" else value)
    if dtype == "complex":
        return "{}"
    if dtype.endswith("_vector"):
        return "{}"
    return cpp_atom(default)


def vector_type(dtype: str) -> str | None:
    return {
        "byte_vector": "std::uint8_t",
        "int_vector": "int",
        "real_vector": "float",
        "float_vector": "float",
        "complex_vector": "gr_complex",
    }.get(dtype)


def matrix_type(dtype: str) -> str | None:
    return {
        "int_matrix": "int",
        "real_matrix": "float",
        "float_matrix": "float",
    }.get(dtype)


class Arg(str):
    """Mako argument whose rendered value is a typed JSON access expression."""

    def __new__(cls, expression: str, attributes: dict[str, Any] | None = None,
                evaluated: Any = None):
        obj = str.__new__(cls, expression)
        obj.attributes = attributes or {}
        obj.evaluated = evaluated
        return obj

    def __getattr__(self, name: str) -> Any:
        try:
            return self.attributes[name]
        except KeyError as error:
            raise AttributeError(name) from error

    def __getitem__(self, name: str) -> Any:
        return self.attributes[name]

    def __call__(self) -> Any:
        return self.evaluated


def option_attributes(param: dict[str, Any], option: Any) -> dict[str, Any]:
    options = [str(item) for item in param.get("options", [])]
    try:
        index = options.index(str(option))
    except ValueError:
        index = 0
    result = {}
    for name, values in (param.get("option_attributes") or {}).items():
        if index < len(values):
            result[name] = Arg(cpp_atom(values[index]), evaluated=values[index])
    return result


def structural_enums(block: dict[str, Any]) -> list[dict[str, Any]]:
    templates = block["cpp_templates"]
    structural_text = "\n".join(
        str(item)
        for key in ("includes", "declarations", "make")
        for item in (templates.get(key, []) if isinstance(templates.get(key, []), list)
                     else [templates.get(key, "")])
    )
    directives = "\n".join(
        line for line in structural_text.splitlines()
        if line.lstrip().startswith(("%", "<%"))
    )
    result = []
    for param in block.get("parameters", []) or []:
        if not isinstance(param, dict) or param.get("dtype") != "enum" or not param.get("options"):
            continue
        pid = str(param["id"])
        structural = bool(re.search(rf"\b{re.escape(pid)}\b", directives))
        for expression in re.findall(r"\$\{([^}]*)\}", structural_text):
            if re.search(rf"\b{re.escape(pid)}\.(?!val\b)", expression):
                structural = True
            if re.fullmatch(rf"\s*{re.escape(pid)}\s*", expression):
                token = "${" + expression + "}"
                for position in (m.start() for m in re.finditer(re.escape(token), structural_text)):
                    before = structural_text[position - 1:position]
                    after = structural_text[position + len(token):position + len(token) + 1]
                    if before.isalnum() or before in "_:<," or after.isalnum() or after in "_:>" :
                        structural = True
        if structural:
            result.append(param)
    return result


def enum_expression(param: dict[str, Any], attribute: str | None = None) -> str:
    options = param.get("options", []) or []
    attributes = param.get("option_attributes") or {}
    values = attributes.get(attribute, []) if attribute else options
    if not values:
        values = options
    pairs = []
    for index, option in enumerate(options):
        value = values[index] if index < len(values) else option
        pairs.append("{" + json.dumps(str(option)) + ", " + cpp_atom(value) + "}")
    default = str(param.get("default", options[0] if options else ""))
    try:
        default_index = [str(item) for item in options].index(default)
    except ValueError:
        default_index = 0
    default_value = values[default_index] if values else default
    return (f'wasm_registry::choice(p, {json.dumps(str(param["id"]))}, '
            f'{{{", ".join(pairs)}}}, {cpp_atom(default_value)})')


def pmt_argument(pid: str, default: Any) -> str:
    """A PMT-valued parameter, decoded from its source text at run time.

    Nothing between the .grc and here evaluates it: the editor's expr.ts is a
    numeric/vector evaluator by design, and a PMT is neither, so the constructor
    call GRC would have run through Python (``pmt.intern("TEST")``) arrives as
    text and ``wasm_registry::pmt_value()`` parses it.  The yaml default is
    passed along so a .grc that omits the parameter still gets the block's
    documented value rather than PMT_NIL.
    """
    expression = "" if default is None else str(default).strip()
    return (f"wasm_registry::pmt_value(p, {json.dumps(pid)}, "
            f"{json.dumps(expression)})")


def resolve_dtype(dtype: str, namespace: dict[str, Any]) -> str:
    if "${" not in dtype:
        return dtype
    return Template(dtype).render(**namespace).strip()


def param_arg(block_id: str, param: dict[str, Any], namespace: dict[str, Any]) -> Arg:
    pid = str(param["id"])
    dtype = resolve_dtype(str(param.get("dtype", "raw")), namespace)
    default = param.get("default")
    quoted_id = json.dumps(pid)
    if (block_id, pid) in OBJECT_PARAMETERS:
        raise ValueError(f"requires typed object parameter {pid}")
    if block_id == "network_socket_pdu" and pid == "type":
        return Arg(f"wasm_registry::text(p, {quoted_id}, \"TCP_SERVER\")")
    if dtype == "enum":
        expression = enum_expression(param)
        if block_id in {"digital_mpsk_snr_est_cc", "digital_probe_mpsk_snr_est_c"} and pid == "type":
            expression = f"static_cast<digital::snr_est_type_t>({expression})"
        attrs = {
            name: Arg(enum_expression(param, name))
            for name in (param.get("option_attributes") or {})
        }
        return Arg(expression, attrs)
    if dtype == "int":
        return Arg(f"wasm_registry::number<int>(p, {quoted_id}, {fallback(dtype, default)})")
    if dtype == "hex":
        return Arg(f"wasm_registry::number<std::uint64_t>(p, {quoted_id}, {fallback(dtype, default)})")
    if dtype in {"real", "float"}:
        return Arg(f"wasm_registry::number<double>(p, {quoted_id}, {fallback(dtype, default)})")
    if dtype == "bool":
        return Arg(f"wasm_registry::boolean(p, {quoted_id}, {fallback(dtype, default)})")
    if dtype in {"string", "file_open", "file_save", "dir_select"}:
        expression = f"wasm_registry::text(p, {quoted_id}, {fallback(dtype, default)})"
        if dtype in {"file_open", "file_save"}:
            expression += ".c_str()"
        return Arg(expression)
    if dtype == "complex":
        return Arg(f"wasm_registry::complex(p, {quoted_id})")
    # `pmt` is a browser-only dtype, set by an overlay on a parameter upstream
    # types `raw` because it holds a Python PMT constructor call. Nothing on the
    # way here evaluates it -- the editor's expr.ts is a numeric evaluator -- so
    # the value reaches the runner as its source text and
    # wasm_registry::pmt_value() parses the constructor grammar.
    if dtype == "pmt":
        return Arg(pmt_argument(pid, default))
    # `string_vector` is a browser-only dtype, set by an overlay on a parameter
    # upstream types `raw` because it holds a Python sequence of quoted names --
    # gr-radar's message keys, `('range','velocity')`. Nothing evaluates it on
    # the way here, so the runner parses the sequence itself rather than through
    # the JSON vector reader, which would choke on the single quotes and the
    # one-element tuple's trailing comma.
    if dtype == "string_vector":
        return Arg(f"wasm_registry::string_vector(p, {quoted_id})")
    item_type = matrix_type(dtype)
    if item_type:
        return Arg(f"wasm_registry::matrix<{item_type}>(p, {quoted_id})")
    item_type = vector_type(dtype)
    if item_type:
        if block_id == "blocks_blockinterleaver_xx" and pid == "interleaver_indices":
            item_type = "std::size_t"
        if block_id == "iir_filter_xxx" and pid in {"fftaps", "fbtaps"}:
            item_type = {
                "ffd": "double",
                "ccf": "float",
                "ccd": "double",
                "ccc": "gr_complex",
                "ccz": "gr_complexd",
            }.get(str(namespace["type"].evaluated), item_type)
        if pid in {"const", "scale", "vector"} and "type" in namespace:
            item_type = {
                "complex": "gr_complex",
                "float": "float",
                "int": "std::int32_t",
                "short": "std::int16_t",
                "byte": "std::uint8_t",
            }.get(str(namespace["type"].evaluated), item_type)
        return Arg(f"wasm_registry::vector<{item_type}>(p, {quoted_id})")
    if dtype == "raw" and param.get("options"):
        enum = dict(param)
        enum["dtype"] = "enum"
        return Arg(enum_expression(enum))
    if dtype == "raw" and pid in {
        "begin_tag",
        "true_key",
        "true_value",
        "false_key",
        "false_value",
        "meta",
    }:
        return Arg(pmt_argument(pid, default))
    if dtype == "raw" and pid == "gfpoly":
        return Arg(f"wasm_registry::number<int>(p, {quoted_id}, {fallback('int', default)})")
    if dtype == "raw" and pid == "special_tags":
        return Arg(f"wasm_registry::vector<std::string>(p, {quoted_id})")
    if dtype == "raw" and pid == "sync_word":
        return Arg(f"wasm_registry::vector<std::uint8_t>(p, {quoted_id})")
    if dtype == "raw" and pid == "cp_len":
        input_size = namespace.get("input_size", "0")
        return Arg(
            f"wasm_registry::cp_lengths(p, {quoted_id}, {input_size})",
            evaluated=[],
        )
    if dtype == "raw" and pid in {"bus_structure_source", "bus_structure_sink"}:
        return Arg("{}")
    if dtype == "raw" and pid == "tags":
        # A list of Tag Object variable names, resolved against the tag objects
        # built before any block (see wasm_registry::tag_objects).
        return Arg(f"wasm_registry::tag_objects(p, {quoted_id})")
    if dtype == "raw" and pid == "vector":
        # vector_source's selected type supplies its vector dtype.
        selected_type = namespace.get("type")
        selected_dtype = getattr(selected_type, "vec_type", "real_vector")
        item_type = {
            "complex": "gr_complex",
            "float": "float",
            "int": "std::int32_t",
            "short": "std::int16_t",
            "byte": "std::uint8_t",
        }.get(str(selected_type.evaluated), vector_type(str(selected_dtype)) or "float")
        return Arg(f"wasm_registry::vector<{item_type}>(p, {quoted_id})")
    raise ValueError(f"unsupported parameter {pid} ({dtype})")


# A GRC callback is a live setter: GRC's own generator re-emits it whenever a
# parameter's expression changes, which is how a native flowgraph's Range slider
# moves a running block. The browser has no generator, so the runner binds a QT
# GUI Range straight to a factory's `numeric_setters` entry instead (see the
# parameter loop in runner/src/runner.cpp). Emitting one per callback is what
# keeps a generated factory as live as a hand-written one -- without it the
# slider still moves and publishes, nothing is subscribed, and the parameter is
# silently frozen at its construction-time value.
#
# The simple shape can call the block setter directly. Compound callbacks need
# shared state: changing one input to (for example) a firdes expression must
# recompute it with the latest values of all its other Range-driven inputs.
CALLBACK_SETTER = re.compile(
    r"^\s*(set_\w+)\(\s*\$\{\s*(\w+)\s*\}\s*\)\s*;?\s*$"
)
CALLBACK_METHOD = re.compile(
    r"^\s*(?:(?:set|setup|update)_\w+|reset)\s*\(.*\)\s*;?\s*(?:#.*)?$",
    re.DOTALL,
)
CALLBACK_EXPRESSION = re.compile(r"\$\{([^}]*)\}")

# The C++ type the setter argument is cast to, per GRC dtype. These mirror the
# types param_arg() reads the same parameter as at construction, so a setter and
# its constructor argument cannot disagree about, say, int versus double.
SETTER_CASTS = {
    "bool": "bool",
    "int": "int",
    "hex": "std::uint64_t",
    "real": "double",
    "float": "double",
}


def compound_setter_cast(dtype: str) -> str | None:
    """The C++ type a live control's `double` is stored as, for one member of a
    compound callback's parameter group.

    Vector dtypes are allowed *here only*. Native GRC lets a Range drive a
    `*_vector` parameter -- an expression that evaluates to a scalar is listified
    (`_lisitify_flag` in grc/core/params/param.py) and a control publishes a
    scalar -- and gr-radar's Static Target Simulator is the worked example:
    upstream's own examples wire a Range straight to its `range`/`velocity`, one
    argument of the `setup_targets(...)` group. wasm_registry::assign_numeric()
    does the listifying on the way in.

    The plain `set_x(${x})` path above deliberately does not get this. A
    compound callback re-applies a *group* of parameters whose current values
    the factory has to hold anyway, so a vector among them is stored state that
    can equally well be driven; a standalone vector setter -- a filter's `taps`,
    an FFT's `window`, Multiply Const's `const` -- is not something anyone points
    a slider at, and generating a binding that would replace a whole tap set with
    one number is a worse answer than leaving it alone.
    """
    direct = SETTER_CASTS.get(dtype)
    if direct:
        return direct
    item = vector_type(dtype)
    return f"std::vector<{item}>" if item else None


def callback_setters(block: dict[str, Any], namespace: dict[str, Any],
                     structural: set[str]) -> tuple[
                         list[tuple[str, str, str]],
                         list[tuple[list[tuple[str, str, str]], str]],
                     ]:
    """Return direct setters and stateful compound callbacks.

    A direct setter is ``(parameter id, setter method, cast type)``. A compound
    callback is ``(live parameters, rendered block call)``, where every live
    parameter is ``(id, cast type, initial expression)``. The renderer installs
    one numeric setter per live parameter and reruns every callback that depends
    on it.

    `cpp_templates` wins over `templates` where both exist: the Python and C++
    method names agree throughout GNU Radio today, but the C++ list is the one
    that describes the class this factory actually builds.
    """
    cpp = block.get("cpp_templates") or {}
    # An explicit cpp callbacks list wins even when empty: that is how an overlay
    # says "this rebuild exposes no setters" for a block whose upstream Python
    # hierarchy has them but our C++ stand-in does not.
    callbacks = (cpp["callbacks"] if "callbacks" in cpp
                 else (block.get("templates") or {}).get("callbacks") or [])
    params = {str(param["id"]): param for param in block.get("parameters", []) or []
              if isinstance(param, dict) and "id" in param}
    setters: dict[str, tuple[str, str, str]] = {}
    compound: list[tuple[list[tuple[str, str, str]], str]] = []
    for callback in callbacks:
        callback_text = str(callback)
        match = CALLBACK_SETTER.match(callback_text)
        if match:
            method, pid = match.group(1), match.group(2)
            param = params.get(pid)
            # A structural parameter picks which class was constructed, so it
            # cannot be changed on a running graph whatever the yaml says.
            if param is None or pid in structural:
                continue
            cast = SETTER_CASTS.get(
                resolve_dtype(str(param.get("dtype", "raw")), namespace)
            )
            if cast is None:
                continue
            setters.setdefault(pid, (pid, method, cast))
            continue

        # Only translate an ordinary block method call. File open callbacks,
        # comments used as reset triggers, and other generator-specific snippets
        # still need a hand-written factory if they are to become live.
        expressions = CALLBACK_EXPRESSION.findall(callback_text)
        live: list[tuple[str, str, str]] = []
        for pid, param in params.items():
            if pid in structural or not any(
                re.search(rf"\b{re.escape(pid)}\b", expression)
                for expression in expressions
            ):
                continue
            cast = compound_setter_cast(
                resolve_dtype(str(param.get("dtype", "raw")), namespace)
            )
            if cast is None:
                continue
            live.append((pid, cast, str(namespace[pid])))
        if not live:
            continue
        if not CALLBACK_METHOD.match(callback_text):
            ids = ", ".join(pid for pid, _cast, _initial in live)
            raise ValueError(
                f"unsupported live callback for {ids}: {callback_text.strip()}"
            )

        live_namespace = dict(namespace)
        for pid, _cast, _initial in live:
            original = namespace[pid]
            field = "p_" + re.sub(r"\W", "_", pid)
            live_namespace[pid] = Arg(
                f"live->{field}",
                getattr(original, "attributes", {}),
                getattr(original, "evaluated", None),
            )
        rendered = Template(callback_text).render(**live_namespace)
        rendered = rendered.split("#", 1)[0]
        rendered = translate_make(rendered, cpp.get("translations")).rstrip(";")
        if not CALLBACK_METHOD.match(rendered):
            raise ValueError(f"could not translate live callback: {callback_text.strip()}")
        compound.append((live, f"block->{rendered};"))
    return list(setters.values()), compound


def render_namespace(block: dict[str, Any], selections: dict[str, Any]) -> dict[str, Any]:
    namespace: dict[str, Any] = {
        "id": Arg("block", evaluated="block"),
        "True": Arg("true", evaluated=True),
        "False": Arg("false", evaluated=False),
    }
    params = {str(param["id"]): param for param in block.get("parameters", []) or []
              if isinstance(param, dict) and "id" in param}
    for pid, option in selections.items():
        param = params[pid]
        namespace[pid] = Arg(cpp_atom(option), option_attributes(param, option), option)
    # Resolve parameters in declaration order because a dynamic dtype may use a
    # structural enum that was installed above.
    for pid, param in params.items():
        if pid not in namespace:
            namespace[pid] = param_arg(str(block["id"]), param, namespace)
    return namespace


def translate_make(make: str, translations: dict[str, str] | None = None) -> str:
    make = make.replace("\u00a0", " ")
    # Preserve enum lookup keys such as "True" while translating Python bool
    # literals that appear directly in upstream C++ templates.
    make = re.sub(r"(?<![\"'])\bTrue\b(?![\"'])", "true", make)
    make = re.sub(r"(?<![\"'])\bFalse\b(?![\"'])", "false", make)
    make = make.replace(".c_str().c_str()", ".c_str()")
    make = re.sub(r"\bpfb::([A-Za-z0-9_]+)", r"filter::pfb_\1", make)
    make = re.sub(r"(?<!:)\bfirdes::", "filter::firdes::", make)
    make = re.sub(r"\banalog::cpm\.([A-Za-z0-9_]+)", r"analog::cpm::\1", make)
    for pattern, replacement in (translations or {}).items():
        make = re.sub(pattern.replace("\\\\", "\\"), replacement, make)
    make = re.sub(r"this->block\s*=", "auto block =", make, count=1)
    make = make.replace("this->block->", "block->")
    make = make.replace("this->block.", "block->")
    make = make.replace("self->block->", "block->")
    make = make.replace("self->block.", "block->")
    make = re.sub(r"\b(count|bits_per_byte|reset_tag_key)\s*=\s*", "", make)
    # In a compound callback the live argument is already a plain C++ field,
    # unlike the nested JSON reader in the construction template. Translate
    # this simpler form before the general block_limit expression below.
    make = re.sub(
        r"block_limit\((live->\w+)\)",
        r'wasm_registry::throttle_limit(p, \1, wasm_registry::number<double>(p, "samples_per_second", 0.0))',
        make,
    )
    make = re.sub(
        r"block_limit\(([^)]+(?:\)[^)]*)?)\)",
        r'wasm_registry::throttle_limit(p, \1, wasm_registry::number<double>(p, "samples_per_second", 0.0))',
        make,
    )
    # Several upstream templates turn a runtime vector into a braced initializer.
    make = re.sub(
        r"std::vector<([^>]+)>\s+(\w+)\s*=\s*\{\s*(wasm_registry::vector<[^;]+)\s*\};",
        r"auto \2 = \3;",
        make,
    )
    return make.strip()


def render_block(block: dict[str, Any]) -> tuple[list[str], str]:
    if block["id"] == "blocks_add_const_vxx":
        includes = [
            "#include <gnuradio/blocks/add_const_bb.h>",
            "#include <gnuradio/blocks/add_const_cc.h>",
            "#include <gnuradio/blocks/add_const_ff.h>",
            "#include <gnuradio/blocks/add_const_ii.h>",
            "#include <gnuradio/blocks/add_const_ss.h>",
            "#include <gnuradio/blocks/add_const_v.h>",
        ]
        factory = r'''    registry.emplace("blocks_add_const_vxx", [](const nlohmann::json& p) -> BuiltBlock {
        const auto type = wasm_registry::text(p, "type", "complex");
        const bool vector = wasm_registry::number<int>(p, "vlen", 1) > 1;
        if (type == "complex") {
            if (vector)
                return { blocks::add_const_vcc::make(wasm_registry::vector<gr_complex>(p, "const")), nullptr };
            auto block = blocks::add_const_cc::make(wasm_registry::complex(p, "const"));
            BuiltBlock built{ block };
            built.numeric_setters["const"] = [block](double value) {
                block->set_k(gr_complex(static_cast<float>(value), 0.0F));
            };
            return built;
        }
        if (type == "float") {
            if (vector)
                return { blocks::add_const_vff::make(wasm_registry::vector<float>(p, "const")), nullptr };
            auto block = blocks::add_const_ff::make(wasm_registry::number<float>(p, "const", 0.0F));
            BuiltBlock built{ block };
            built.numeric_setters["const"] =
                [block](double value) { block->set_k(static_cast<float>(value)); };
            return built;
        }
        if (type == "int") {
            if (vector)
                return { blocks::add_const_vii::make(wasm_registry::vector<std::int32_t>(p, "const")), nullptr };
            auto block = blocks::add_const_ii::make(wasm_registry::number<int>(p, "const", 0));
            BuiltBlock built{ block };
            built.numeric_setters["const"] =
                [block](double value) { block->set_k(static_cast<int>(value)); };
            return built;
        }
        if (type == "short") {
            if (vector)
                return { blocks::add_const_vss::make(wasm_registry::vector<std::int16_t>(p, "const")), nullptr };
            auto block = blocks::add_const_ss::make(wasm_registry::number<short>(p, "const", 0));
            BuiltBlock built{ block };
            built.numeric_setters["const"] =
                [block](double value) { block->set_k(static_cast<short>(value)); };
            return built;
        }
        if (type == "byte") {
            if (vector)
                return { blocks::add_const_vbb::make(wasm_registry::vector<std::uint8_t>(p, "const")), nullptr };
            auto block = blocks::add_const_bb::make(wasm_registry::number<unsigned char>(p, "const", 0));
            BuiltBlock built{ block };
            built.numeric_setters["const"] = [block](double value) {
                block->set_k(static_cast<unsigned char>(value));
            };
            return built;
        }
        throw std::runtime_error("unsupported type selection for blocks_add_const_vxx");
    });'''
        return includes, factory
    structural = structural_enums(block)
    structural_ids = {str(param["id"]) for param in structural}
    combinations = list(itertools.product(*[param["options"] for param in structural])) or [()]
    variants: list[tuple[
        dict[str, Any],
        str,
        tuple[
            list[tuple[str, str, str]],
            list[tuple[list[tuple[str, str, str]], str]],
        ],
    ]] = []
    includes: set[str] = set()
    for choices in combinations:
        selections = {str(param["id"]): choice for param, choice in zip(structural, choices)}
        namespace = render_namespace(block, selections)
        cpp = block["cpp_templates"]
        for include in cpp.get("includes", []) or []:
            includes.add(Template(str(include)).render(**namespace).strip())
        make_template = str(cpp.get("make", ""))
        make_template = re.sub(r"\$\{str\((\w+)\)\[1:-1\]\}", r"${\1}", make_template)
        make_template = re.sub(r"\$\{str\(eval\((\w+)\)\)\[1:-1\]\}", r"${\1}", make_template)
        make = Template(make_template).render(**namespace)
        make = translate_make(make, cpp.get("translations"))
        if "auto block =" not in make:
            raise ValueError("C++ template does not construct a stream/message block")
        variants.append((selections, make, callback_setters(block, namespace, structural_ids)))

    lines = [f'    registry.emplace("{block["id"]}", [](const nlohmann::json& p) -> BuiltBlock {{']
    for index, (selections, make, callback_plan) in enumerate(variants):
        setters, compound = callback_plan
        tests = [
            f'wasm_registry::text(p, {json.dumps(pid)}, {json.dumps(str(next(param.get("default", param["options"][0]) for param in structural if param["id"] == pid)))}) == {json.dumps(str(option))}'
            for pid, option in selections.items()
        ]
        if len(variants) > 1:
            lines.append(("        if (" if index == 0 else "        else if (") + " && ".join(tests) + ") {")
            indent = "            "
        else:
            indent = "        "
        lines.extend(indent + line for line in make.splitlines())
        if not setters and not compound:
            lines.append(indent + "return { block, nullptr };")
        else:
            lines.append(indent + "BuiltBlock built{ block };")
            simple = {pid: (method, cast) for pid, method, cast in setters}
            compound_state: dict[str, tuple[str, str]] = {}
            calls_by_param: dict[str, list[str]] = defaultdict(list)
            compound_callbacks: list[tuple[str, str]] = []
            for callback_index, (live, call) in enumerate(compound):
                callback_name = f"apply_callback_{callback_index}"
                compound_callbacks.append((callback_name, call))
                for pid, cast, initial in live:
                    compound_state.setdefault(pid, (cast, initial))
                    if callback_name not in calls_by_param[pid]:
                        calls_by_param[pid].append(callback_name)

            if compound_state:
                lines.append(indent + "struct LiveCallbackParams {")
                for pid, (cast, _initial) in compound_state.items():
                    field = "p_" + re.sub(r"\W", "_", pid)
                    lines.append(f"{indent}    {cast} {field};")
                lines.append(indent + "};")
                lines.append(indent + "auto live = std::make_shared<LiveCallbackParams>();")
                for pid, (_cast, initial) in compound_state.items():
                    field = "p_" + re.sub(r"\W", "_", pid)
                    lines.append(f"{indent}live->{field} = {initial};")
                for callback_name, call in compound_callbacks:
                    capture = "block, live, p" if re.search(r"\bp\b", call) else "block, live"
                    lines.append(
                        f"{indent}auto {callback_name} = [{capture}]() {{ {call} }};"
                    )

            for pid in dict.fromkeys([*simple, *calls_by_param]):
                if pid not in calls_by_param:
                    method, cast = simple[pid]
                    lines.append(
                        f'{indent}built.numeric_setters[{json.dumps(pid)}] = '
                        f'[block](double value) {{ block->{method}(static_cast<{cast}>(value)); }};')
                    continue
                cast, _initial = compound_state[pid]
                field = "p_" + re.sub(r"\W", "_", pid)
                if pid not in simple and len(calls_by_param[pid]) == 1:
                    lines.append(
                        f'{indent}wasm_registry::add_numeric_setter(built, '
                        f'{json.dumps(pid)}, live, &LiveCallbackParams::{field}, '
                        f'{calls_by_param[pid][0]});')
                    continue
                captures = ["live", *calls_by_param[pid]]
                if pid in simple:
                    captures.insert(0, "block")
                lines.append(
                    f'{indent}built.numeric_setters[{json.dumps(pid)}] = '
                    f'[{", ".join(captures)}](double value) {{')
                lines.append(
                    f"{indent}    wasm_registry::assign_numeric(live->{field}, value);")
                if pid in simple:
                    method, direct_cast = simple[pid]
                    lines.append(
                        f"{indent}    block->{method}(static_cast<{direct_cast}>(value));"
                    )
                for callback_name in calls_by_param[pid]:
                    lines.append(f"{indent}    {callback_name}();")
                lines.append(indent + "};")
            lines.append(indent + "return built;")
        if len(variants) > 1:
            lines.append("        }")
    if len(variants) > 1:
        lines.append(f'        throw std::runtime_error("unsupported type selection for {block["id"]}");')
    lines.append("    });")
    return sorted(includes), "\n".join(lines)


def load_blocks() -> list[dict[str, Any]]:
    blocks = []
    # Every block id seen, mapped to its module, so an overlay that matched
    # nothing can be reported rather than silently doing nothing.
    seen: dict[str, str] = {}
    for module in MODULES:
        short = module[len("gr-"):] if module.startswith("gr-") else module
        # Direct world-repo modules override same-named gitlinks that may exist
        # in older GNU Radio revisions during the repository migration.
        module_root = MODULE_SOURCE_ROOTS.get(module, WORLD / module)
        if not module_root.is_dir():
            module_root = GR / module
        # Recursive: some OOTs group metadata below grc/. For example,
        # gr-satellites has component subdirectories, while gr-droneid itself is
        # nested below the dji_droneid repository root via source_roots above.
        for path in sorted((module_root / "grc").rglob("*.block.yml")):
            try:
                block = yaml.safe_load(path.read_text())
            except Exception:
                continue
            if not isinstance(block, dict) or "id" not in block:
                continue
            seen[str(block["id"])] = short
            override = BLOCK_OVERRIDES.get(str(block["id"]))
            if override:
                block_overrides.apply(block, override)
                if override.get("hidden"):
                    continue
            if "cpp" not in (block.get("flags") or []) or not block.get("cpp_templates"):
                continue
            if str(block["id"]).startswith("variable_") or block["id"] in CUSTOM_IDS:
                continue
            if block["id"] in INVALID_CPP_TEMPLATES or block["id"] in EXCLUDED_BLOCKS:
                continue
            base = WORLD if path.is_relative_to(WORLD) and not path.is_relative_to(GR) else GR
            block["__path"] = str(path.relative_to(base))
            block["__module"] = short
            blocks.append(block)
    # gr-qtgui and gr-audio are read for their block *ids* alone. Neither is a
    # MODULE above and neither will be: they are not side modules, and every one
    # of their blocks the browser supports has a hand-written factory (the qtgui
    # sinks need a QWidget, the controls are rebuilds of Python widgets, and
    # gr-audio's two blocks are rebuilt on Web Audio in blocks/src/browser_audio.cpp
    # because the component is not built at all). Their overlays are real all the
    # same, and without these ids validate() cannot tell one of them from a typo.
    for component in ("gr-qtgui", "gr-audio"):
        for path in sorted((GR / component / "grc").rglob("*.block.yml")):
            try:
                block = yaml.safe_load(path.read_text())
            except Exception:
                continue
            if isinstance(block, dict) and "id" in block:
                seen.setdefault(str(block["id"]), component[len("gr-"):])
    block_overrides.validate(BLOCK_OVERRIDES, seen)
    # Same typo trap block_overrides.validate() guards: an id that matches no
    # block would silently exclude nothing at all.
    unknown = sorted(set(EXCLUDED_BLOCKS) - set(seen))
    if unknown:
        raise SystemExit("EXCLUDED_BLOCKS names unknown blocks: " + ", ".join(unknown))
    return blocks


def to_side_registration(factory: str) -> str:
    """Rewrite a core `registry.emplace("id", [](...){...});` factory into a side-
    module self-registration `wasm_registry_add("id", +[](...){...});`. The unary
    `+` decays the capture-less lambda to a plain function pointer so it can cross
    the dynamic-link boundary without any C++ ABI coupling."""
    factory = factory.replace('registry.emplace("', 'wasm_registry_add("', 1)
    factory = factory.replace(', [](const nlohmann::json& p)',
                              ', +[](const nlohmann::json& p)', 1)
    return factory


CORE_HEADER = "// Generated by gen_registry.py; do not edit."


def write_if_changed(path: Path, content: str) -> None:
    if path.exists() and path.read_text() == content:
        return
    path.write_text(content)


def write_core_registrar(output_dir: Path, includes: set[str],
                         factories: list[str]) -> None:
    """Blocks statically linked into the main module. Registered directly into the
    registry map at startup (see registry.cpp)."""
    source = [
        CORE_HEADER,
        '#include "registry_helpers.hpp"',
        *sorted(include for include in includes if include),
        "",
        "using namespace gr;",
        "",
        "void register_generated_blocks(std::map<std::string, Factory>& registry)",
        "{",
        *factories,
        "}",
        "",
    ]
    write_if_changed(output_dir / "generated_registry.cpp", "\n".join(source))


def write_side_registrar(output_dir: Path, module: str, includes: set[str],
                        factories: list[str]) -> None:
    """One deferred category = one WebAssembly side module. A file-scope constructor
    runs when the side module is dlopen'd and pushes its factories into the main
    module's registry via the exported wasm_registry_add() shim."""
    source = [
        CORE_HEADER,
        '#include "registry_helpers.hpp"',
        *sorted(include for include in includes if include),
        "",
        "using namespace gr;",
        "",
        "// Provided by the main module (registry.cpp).",
        'extern "C" void wasm_registry_add(const char* id,',
        "                                  BuiltBlock (*factory)(const nlohmann::json&));",
        "",
        "namespace {",
        f"struct Registrar_{module} {{",
        f"    Registrar_{module}()",
        "    {",
        *[to_side_registration(f) for f in factories],
        "    }",
        f"}} g_registrar_{module};",
        "} // namespace",
        "",
    ]
    write_if_changed(
        output_dir / f"generated_registry_{module}.cpp", "\n".join(source)
    )


# ---- repo JavaScript blocks (docs/js-blocks.md) ----------------------------
# A block whose implementation is a file in blocks/js/ rather than C++. Its
# .block.yml carries `flags: [js]` and no `cpp`, so the generated-C++ path above
# skips it for free; all that is left is binding its id to the one generic
# factory and telling the runner which file to fetch.
#
# The point of fetching rather than baking the sources in as string literals: a
# block's *source* then never enters the wasm, so editing one is a file copy. The
# id still does -- the table below is compiled into the main module -- so adding a
# block relinks. See "Adding a repo JS block" in docs/js-blocks.md.
JS_BLOCK_DIR = WORLD / "blocks" / "js"
JS_GRC_DIR = WORLD / "blocks" / "grc"


def load_js_blocks() -> dict[str, str]:
    """`flags: [js]` block ids -> the file under blocks/js/ that implements them."""
    js_blocks: dict[str, str] = {}
    for path in sorted(JS_GRC_DIR.glob("*.block.yml")):
        try:
            block = yaml.safe_load(path.read_text())
        except Exception:
            continue
        if not isinstance(block, dict) or "id" not in block:
            continue
        flags = block.get("flags") or []
        if isinstance(flags, str):
            flags = flags.replace(",", " ").split()
        if "js" not in [str(flag).strip() for flag in flags]:
            continue
        block_id = str(block["id"])
        source = JS_BLOCK_DIR / f"{block_id}.js"
        if not source.is_file():
            raise SystemExit(
                f"{path.name} declares flags: [js] but blocks/js/{block_id}.js does not exist")
        # The yml is authoritative for a repo block, so a descriptor that also
        # declares ports must agree with it -- otherwise the editor draws one
        # thing and the runner builds another, and only the runner would notice.
        check_js_ports_agree(block, source)
        js_blocks[block_id] = f"{block_id}.js"
    return js_blocks


# GRC dtype -> the JS port dtype the runtime understands. Anything else in a yml
# port makes the pair uncheckable, which is reported rather than assumed to agree.
JS_PORT_DTYPES = {"complex", "float", "int", "short", "byte"}


def check_js_ports_agree(block: dict[str, Any], source: Path) -> None:
    """A descriptor's own port declaration is optional; when it is there, it has to
    match the yml. Parsed textually -- this generator does not run JavaScript."""
    text = source.read_text()
    for side, key in (("inputs", "inputs"), ("outputs", "outputs")):
        yml_ports = [p for p in (block.get(side) or [])
                     if str(p.get("domain", "stream")) == "stream"]
        match = re.search(rf"^\s*{key}\s*:\s*\[([^\]]*)\]", text, re.MULTILINE)
        if not match:
            continue
        declared = re.findall(r"['\"](\w+)['\"]", match.group(1))
        if not declared or any(d not in JS_PORT_DTYPES for d in declared):
            continue
        yml_dtypes = [str(p.get("dtype", "")) for p in yml_ports]
        if any(d not in JS_PORT_DTYPES for d in yml_dtypes):
            continue
        if declared != yml_dtypes:
            raise SystemExit(
                f"{source.name}: gr.export() declares {side} {declared}, but "
                f"{block['id']}.block.yml declares {yml_dtypes}. The yml is "
                "authoritative for a repo block; make them agree.")


def write_js_registrar(output_dir: Path, js_blocks: dict[str, str]) -> None:
    """Baked into the main module: repo JS block id -> the file to fetch, and the
    registration of each id against the generic factory in registry.cpp."""
    entries = [f'        {{{json.dumps(bid)}, {json.dumps(path)}}},'
               for bid, path in sorted(js_blocks.items())]
    registrations = [f'    register_js_block(registry, {json.dumps(bid)});'
                     for bid in sorted(js_blocks)]
    source = [
        CORE_HEADER,
        '#include "registry.hpp"',
        "#include <map>",
        "#include <string>",
        "",
        "const std::map<std::string, std::string>& block_js_map()",
        "{",
        "    static const std::map<std::string, std::string> m = {",
        *entries,
        "    };",
        "    return m;",
        "}",
        "",
        "void register_generated_js_blocks(std::map<std::string, Factory>& registry)",
        "{",
        *(registrations or ["    (void)registry;"]),
        "}",
        "",
    ]
    write_if_changed(output_dir / "generated_js_blocks.cpp", "\n".join(source))


def write_module_map(output_dir: Path, block_module: dict[str, str]) -> None:
    """Baked into the main module: block-id -> deferred module name, and the
    inter-module load order. Core blocks are absent (treated as already loaded)."""
    entries = [f'        {{{json.dumps(bid)}, {json.dumps(mod)}}},'
               for bid, mod in sorted(block_module.items())]
    dep_entries = []
    for module, deps in sorted(MODULE_DEPS.items()):
        joined = ", ".join(json.dumps(d) for d in deps)
        dep_entries.append(f'        {{{json.dumps(module)}, {{{joined}}}}},')
    source = [
        CORE_HEADER,
        '#include "registry.hpp"',
        "#include <map>",
        "#include <string>",
        "#include <vector>",
        "",
        "const std::map<std::string, std::string>& block_module_map()",
        "{",
        "    static const std::map<std::string, std::string> m = {",
        *entries,
        "    };",
        "    return m;",
        "}",
        "",
        "const std::map<std::string, std::vector<std::string>>& module_deps()",
        "{",
        "    static const std::map<std::string, std::vector<std::string>> m = {",
        *dep_entries,
        "    };",
        "    return m;",
        "}",
        "",
    ]
    write_if_changed(output_dir / "generated_modules.cpp", "\n".join(source))


def generate(output_dir: Path, manifest: Path) -> None:
    validate_configuration()
    factories: dict[str, list[str]] = defaultdict(list)
    includes: dict[str, set[str]] = defaultdict(set)
    supported = sorted(CUSTOM_IDS)
    skipped: dict[str, str] = dict(EXCLUDED_BLOCKS)
    block_module: dict[str, str] = {}  # deferred blocks only
    counts: dict[str, int] = defaultdict(int)

    for block in load_blocks():
        module = block["__module"]
        try:
            block_includes, factory = render_block(block)
        except Exception as error:
            skipped[str(block["id"])] = str(error)
            continue
        includes[module].update(block_includes)
        factories[module].append(factory)
        supported.append(str(block["id"]))
        counts[module] += 1
        if module in DEFERRED_MODULES:
            block_module[str(block["id"])] = module

    output_dir.mkdir(parents=True, exist_ok=True)

    # Core registrar: blocks/analog/fft/filter compiled straight into the main module.
    core_factories: list[str] = []
    core_includes: set[str] = set()
    for module in CORE_MODULES:
        core_factories += factories.get(module, [])
        core_includes |= includes.get(module, set())
    write_core_registrar(output_dir, core_includes, core_factories)

    # One side module per deferred category (skip any that yielded no factories).
    emitted_modules = []
    for module in DEFERRED_MODULES:
        if not factories.get(module):
            continue
        write_side_registrar(output_dir, module, includes[module], factories[module])
        emitted_modules.append(module)

    write_module_map(output_dir, block_module)

    # Repo JS blocks: a third category beside "generated C++" and "custom". They
    # are registered from a generated table rather than by hand in registry.cpp,
    # so read_custom_factory_ids() does not see them -- but the palette does, and
    # without a manifest entry every one of them greys out.
    js_blocks = load_js_blocks()
    write_js_registrar(output_dir, js_blocks)
    supported.extend(js_blocks)

    manifest_content = json.dumps({
        "supported": sorted(set(supported)),
        "skipped": skipped,
        # Blocks that occupy a tile in the runner window (see read_gui_ids).
        "gui": sorted(GUI_IDS),
        "core_modules": list(CORE_MODULES),
        "deferred_modules": emitted_modules,
        "module_deps": MODULE_DEPS,
        "block_module": block_module,
        # blocks/js/<id>.js, fetched at run time rather than linked in.
        "js_blocks": js_blocks,
    }, indent=2) + "\n"
    write_if_changed(manifest, manifest_content)

    core_total = sum(counts.get(m, 0) for m in CORE_MODULES)
    deferred_summary = ", ".join(f"{m}={counts[m]}" for m in emitted_modules)
    print(f"generated core={core_total} (+ {len(CUSTOM_IDS)} custom, "
          f"{len(js_blocks)} js); "
          f"deferred: {deferred_summary}; skipped {len(skipped)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path,
                        default=Path(__file__).with_name("src"),
                        help="directory for generated_registry*.cpp / generated_modules.cpp")
    parser.add_argument("--manifest", type=Path,
                        default=Path(__file__).with_name("generated_blocks.json"))
    args = parser.parse_args()
    generate(args.output_dir, args.manifest)


if __name__ == "__main__":
    main()
