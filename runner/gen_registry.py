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
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml
from mako.template import Template


REPO = Path(__file__).resolve().parents[2]
MODULES = (
    "gr-blocks",
    "gr-analog",
    "gr-fft",
    "gr-filter",
    "gr-digital",
    "gr-dtv",
    "gr-network",
    "gr-pdu",
    "gr-vocoder",
    "gr-rds",
    "gr-foo",
    "gr-dvbs2",
    "gr-dvbs2rx",
)

# Block categories whose C++ is statically linked into the main runner module and
# always available. Everything else is compiled into a per-module WebAssembly side
# module that is fetched on demand the first time a flowgraph uses one of its
# blocks (see the runner's dlopen loader and CMakeLists side-module targets).
CORE_MODULES = ("blocks", "analog", "fft", "filter")
DEFERRED_MODULES = ("digital", "dtv", "network", "pdu", "vocoder", "rds", "foo", "dvbs2", "dvbs2rx")

# Load-order dependencies between DEFERRED modules only (core is always present).
# Empty today: every deferred module references only core symbols (fec + qtgui
# stay in core), so none depends on another side module.
MODULE_DEPS: dict[str, list[str]] = {}

# These have direct C++ flags, but their constructor takes another GRC variable
# object.  Supporting them requires a typed object registry, not a block factory.
OBJECT_PARAMETERS = {
    ("filterbank_vcvcf", "taps"),
    ("digital_symbol_sync_xx", "constellation"),
    ("digital_protocol_formatter_async", "format"),
    ("digital_constellation_soft_decoder_cf", "constellation"),
    ("digital_constellation_encoder_bc", "constellation"),
    ("digital_protocol_formatter_bb", "format"),
    ("digital_ofdm_frame_equalizer_vcvc", "equalizer"),
    ("digital_protocol_parser_b", "format"),
    ("digital_framer_sink_1", "target_queue"),
    ("digital_ofdm_carrier_allocator_cvc", "occupied_carriers"),
    ("digital_packet_headergenerator_bb", "header_formatter"),
    ("digital_constellation_receiver_cb", "constellation"),
    ("digital_packet_sink", "target_queue"),
    ("digital_constellation_decoder_cb", "constellation"),
    ("digital_ofdm_serializer_vcc", "occupied_carriers"),
}

# Custom WASM factories provide widgets, live callbacks, or a browser-safe
# implementation.  Do not emit duplicate generated code for them.
CUSTOM_IDS = {
    "variable_qtgui_range",
    "variable_qtgui_chooser",
    "variable_qtgui_push_button",
    "analog_sig_source_x",
    "analog_noise_source_x",
    "analog_random_source_x",
    "analog_random_uniform_source_x",
    "analog_const_source_x",
    "blocks_null_source",
    "digital_psk_mod",
    "blocks_throttle",
    "blocks_head",
    "blocks_delay",
    "blocks_add_xx",
    "blocks_sub_xx",
    "blocks_multiply_xx",
    "blocks_divide_xx",
    "blocks_multiply_const_xx",
    "blocks_conjugate_cc",
    "blocks_complex_to_mag",
    "blocks_complex_to_mag_squared",
    "blocks_complex_to_float",
    "blocks_float_to_complex",
    "blocks_file_source",
    "blocks_interleaved_short_to_complex",
    "blocks_null_sink",
    "qtgui_time_sink_x",
    "qtgui_freq_sink_x",
    "qtgui_const_sink_x",
    "qtgui_waterfall_sink_x",
}

INVALID_CPP_TEMPLATES = {
    # Upstream template references a nonexistent `${type}` parameter.
    "filter_delay_fc",
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
        "int_vector": "int",
        "real_vector": "float",
        "float_vector": "float",
        "complex_vector": "gr_complex",
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
    if dtype == "raw" and pid in {"begin_tag", "true_key", "true_value", "false_key", "false_value"}:
        return Arg(f"wasm_registry::pmt_value(p, {quoted_id})")
    if dtype == "raw" and pid == "gfpoly":
        return Arg(f"wasm_registry::number<int>(p, {quoted_id}, {fallback('int', default)})")
    if dtype == "raw" and pid == "special_tags":
        return Arg(f"wasm_registry::vector<std::string>(p, {quoted_id})")
    if dtype == "raw" and pid == "cp_len":
        input_size = namespace.get("input_size", "0")
        return Arg(
            f"wasm_registry::cp_lengths(p, {quoted_id}, {input_size})",
            evaluated=[],
        )
    if dtype == "raw" and pid in {"bus_structure_source", "bus_structure_sink"}:
        return Arg("{}")
    if dtype == "raw" and pid == "tags":
        return Arg("std::vector<gr::tag_t>{}")
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
        if (type == "complex")
            return { vector
                ? static_cast<gr::basic_block_sptr>(blocks::add_const_vcc::make(wasm_registry::vector<gr_complex>(p, "const")))
                : static_cast<gr::basic_block_sptr>(blocks::add_const_cc::make(wasm_registry::complex(p, "const"))), nullptr };
        if (type == "float")
            return { vector
                ? static_cast<gr::basic_block_sptr>(blocks::add_const_vff::make(wasm_registry::vector<float>(p, "const")))
                : static_cast<gr::basic_block_sptr>(blocks::add_const_ff::make(wasm_registry::number<float>(p, "const", 0.0F))), nullptr };
        if (type == "int")
            return { vector
                ? static_cast<gr::basic_block_sptr>(blocks::add_const_vii::make(wasm_registry::vector<std::int32_t>(p, "const")))
                : static_cast<gr::basic_block_sptr>(blocks::add_const_ii::make(wasm_registry::number<int>(p, "const", 0))), nullptr };
        if (type == "short")
            return { vector
                ? static_cast<gr::basic_block_sptr>(blocks::add_const_vss::make(wasm_registry::vector<std::int16_t>(p, "const")))
                : static_cast<gr::basic_block_sptr>(blocks::add_const_ss::make(wasm_registry::number<short>(p, "const", 0))), nullptr };
        if (type == "byte")
            return { vector
                ? static_cast<gr::basic_block_sptr>(blocks::add_const_vbb::make(wasm_registry::vector<std::uint8_t>(p, "const")))
                : static_cast<gr::basic_block_sptr>(blocks::add_const_bb::make(wasm_registry::number<unsigned char>(p, "const", 0))), nullptr };
        throw std::runtime_error("unsupported type selection for blocks_add_const_vxx");
    });'''
        return includes, factory
    structural = structural_enums(block)
    combinations = list(itertools.product(*[param["options"] for param in structural])) or [()]
    variants: list[tuple[dict[str, Any], str]] = []
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
        variants.append((selections, make))

    lines = [f'    registry.emplace("{block["id"]}", [](const nlohmann::json& p) -> BuiltBlock {{']
    for index, (selections, make) in enumerate(variants):
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
        lines.append(indent + "return { block, nullptr };")
        if len(variants) > 1:
            lines.append("        }")
    if len(variants) > 1:
        lines.append(f'        throw std::runtime_error("unsupported type selection for {block["id"]}");')
    lines.append("    });")
    return sorted(includes), "\n".join(lines)


def load_blocks() -> list[dict[str, Any]]:
    blocks = []
    for module in MODULES:
        short = module[len("gr-"):] if module.startswith("gr-") else module
        for path in sorted((REPO / module / "grc").glob("*.block.yml")):
            try:
                block = yaml.safe_load(path.read_text())
            except Exception:
                continue
            if not isinstance(block, dict) or "id" not in block:
                continue
            if "cpp" not in (block.get("flags") or []) or not block.get("cpp_templates"):
                continue
            if str(block["id"]).startswith("variable_") or block["id"] in CUSTOM_IDS:
                continue
            if block["id"] in INVALID_CPP_TEMPLATES:
                continue
            block["__path"] = str(path.relative_to(REPO))
            block["__module"] = short
            blocks.append(block)
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
    (output_dir / "generated_registry.cpp").write_text("\n".join(source))


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
    (output_dir / f"generated_registry_{module}.cpp").write_text("\n".join(source))


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
    (output_dir / "generated_modules.cpp").write_text("\n".join(source))


def generate(output_dir: Path, manifest: Path) -> None:
    factories: dict[str, list[str]] = defaultdict(list)
    includes: dict[str, set[str]] = defaultdict(set)
    supported = sorted(CUSTOM_IDS)
    skipped: dict[str, str] = {}
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

    manifest.write_text(json.dumps({
        "supported": sorted(set(supported)),
        "skipped": skipped,
        "core_modules": list(CORE_MODULES),
        "deferred_modules": emitted_modules,
        "module_deps": MODULE_DEPS,
        "block_module": block_module,
    }, indent=2) + "\n")

    core_total = sum(counts.get(m, 0) for m in CORE_MODULES)
    deferred_summary = ", ".join(f"{m}={counts[m]}" for m in emitted_modules)
    print(f"generated core={core_total} (+ {len(CUSTOM_IDS)} custom); "
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
