#!/usr/bin/env python3
"""Generate the editor's block-library JSON from GNU Radio .block.yml files.
Build-time only (no Python at runtime). Emits id/label/category/params/ports and
documentation so the TS editor can render the native-style property dialog.
Block categories are path-segment arrays so names containing "/" remain a
single category."""
import sys, os, json, glob, re, ast, yaml
from urllib.parse import urljoin

# The world repo owns the app and OOT modules; GNU Radio is a source submodule.
WORLD = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GR = os.path.abspath(os.environ.get("GR", os.path.join(WORLD, "gnuradio")))
MODULE_CONFIG = json.load(open(os.path.join(WORLD, "runner", "modules.json")))
MODULE_SOURCE_ROOTS = {
    module: os.path.join(WORLD, relative)
    for module, relative in MODULE_CONFIG.get("source_roots", {}).items()
}

# Mirror native GRC's block search. A direct world-repo OOT module overrides a
# same-named gitlink in an older GNU Radio revision during the migration.
module_dirs = {"grc": os.path.join(GR, "grc", "blocks")}
oot_modules = set()
for path in sorted(glob.glob(os.path.join(GR, "gr-*", "grc"))):
    module = os.path.basename(os.path.dirname(path))
    if module != "gr-heir":
        module_dirs[module] = path
for path in sorted(glob.glob(os.path.join(WORLD, "gr-*", "grc"))):
    module = os.path.basename(os.path.dirname(path))
    if module != "gr-heir":
        module_dirs[module] = path
        oot_modules.add(module)
for module, root in sorted(MODULE_SOURCE_ROOTS.items()):
    module_dirs[module] = os.path.join(root, "grc")
    oot_modules.add(module)
OOT_MODULE_BY_DIR = {
    module_dirs[module]: module for module in oot_modules
}
WORLD_BLOCKS = os.path.join(WORLD, "blocks", "grc")
MODULES = [module_dirs["grc"]] + [
    module_dirs[module] for module in sorted(module_dirs) if module != "grc"
] + [
    # Runner-only blocks: browser-specific sinks with no upstream definition.
    WORLD_BLOCKS
]
MANIFEST = os.path.join(WORLD, "runner", "generated_blocks.json")
WIKI_BLOCK_DOCS_URL_PREFIX = "https://wiki.gnuradio.org/index.php/"

# The same browser-only block metadata the runtime factory generator applies
# (blocks/overlays/*/metadata.yml), through the same
# module. Palette entry and runtime factory must describe the same block, and a
# second copy of the merge here would be free to drift from runner/gen_registry.py.
sys.path.insert(0, os.path.join(WORLD, "tools"))
import block_overrides
BLOCK_OVERRIDES = block_overrides.load()


# Native GRC imports each Python binding and reads its generated __doc__ string.
# The browser deliberately has no Python runtime, but those strings originate
# in Doxygen comments on the same public C++ headers we compile. Extract the
# class and make() comments at palette-generation time and ship their plain text.
HEADER_ROOTS = [
    os.path.join(path, "include")
    for path in sorted(glob.glob(os.path.join(GR, "gr-*")) +
                       glob.glob(os.path.join(WORLD, "gr-*")))
    if os.path.isdir(os.path.join(path, "include"))
] + [
    os.path.join(root, "include") for root in MODULE_SOURCE_ROOTS.values()
] + [os.path.join(WORLD, "qtgui", "include")]


def resolve_header(include):
    """Resolve a cpp_templates #include against in-tree and OOT include roots."""
    for root in HEADER_ROOTS:
        path = os.path.join(root, include)
        if os.path.isfile(path):
            return path
    return None


def expand_include_template(include, block):
    """Expand ${param.attribute} include names from the parameter metadata."""
    variants = [include]
    params = {
        str(param.get("id")): param
        for param in block.get("parameters", []) or []
        if isinstance(param, dict) and param.get("id")
    }
    for param_id, attribute in re.findall(r"\$\{(\w+)(?:\.(\w+))?\}", include):
        param = params.get(param_id, {})
        if attribute:
            values = (param.get("option_attributes") or {}).get(attribute) or []
        else:
            values = param.get("options") or []
        placeholder = "${" + param_id + ("." + attribute if attribute else "") + "}"
        variants = [
            variant.replace(placeholder, str(value))
            for variant in variants for value in values
        ]
        if not variants:
            return [include]
    return variants


def python_option(value):
    """One enum value as GRC writes it into a .grc.

    Almost every boolean parameter spells its options ``['True', 'False']``, but
    a handful of blocks (Matrix Interleaver, QT GUI Matrix Sink, three
    gr-satellites decoders) leave the quotes off, so yaml hands back Python
    ``True``/``False``.  The .grc still stores the value as the text "False", and
    the editor validates a value by looking it up among the options -- so
    without this the block is rejected for holding its own default.
    """
    return str(value) if isinstance(value, bool) else value


def python_options(options):
    """A parameter's option list, each value spelled as GRC writes it."""
    if not isinstance(options, list):
        return options
    return [python_option(option) for option in options]


def unquoted(value):
    """A value with one layer of matching Python quotes removed."""
    text = str(value).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    return text


# Every enum default this had to repair, as "block.param: was -> is", for the
# generator's own summary line. Silence would make an upstream slip look like a
# deliberate default.
REPAIRED_DEFAULTS: list[str] = []


def enum_default(block_id, param):
    """A choice parameter's default, guaranteed to be one of its own options.

    An enum whose default is not among its options puts the block on the canvas
    already in error, because the editor validates a value by looking it up in
    the option list -- and the block would be holding the value the palette gave
    it.  Roughly forty parameters across the tree are in that state upstream, in
    four flavours, and GRC never notices because it only evaluates the value it
    is handed:

    * a widget hint pasted into the wrong key (gr-satellites' CCSDS blocks all
      default to the literal ``drop_down``);
    * an option *label* where the value belongs (gr-iio's ``'Input'`` for an
      option list of ``['False', 'True']``);
    * a value that predates the option list (the Frequency Sink's averaging
      still defaults to ``False``, from before the choice became an alpha, and
      the Time Raster Sink offers no ``complex`` mode at all);
    * a plain ``True`` for a three-way choice (gr-pdu's PDU Lambda).

    A label is translated to the option it labels; anything else falls back to
    the first option, which is both what GRC does for an enum with no default at
    all and what ``wasm_registry::choice()`` already falls back to in the runner,
    so the palette and the runtime agree on the same value.  A default that
    differs from its option only by Python quoting is *kept*: the quotes are
    usually load-bearing in upstream's own code generation (QT GUI Range renders
    ``${rangeType}`` straight into a Python call), and this editor's validation
    compares enum values with them stripped.
    """
    default = python_option(param.get("default", ""))
    if str(param.get("dtype", "")) not in {"enum", "bool"}:
        return default
    options = [str(option) for option in python_options(param.get("options") or [])]
    # An absent default already means "the first option" to every reader.
    if not options or default in (None, ""):
        return default
    if str(default) in options or unquoted(default) in map(unquoted, options):
        return default
    labels = [str(label) for label in (param.get("option_labels") or [])]
    for label, option in zip(labels, options):
        if unquoted(label) == unquoted(default):
            REPAIRED_DEFAULTS.append(f"{block_id}.{param['id']}: {default} -> {option}")
            return option
    REPAIRED_DEFAULTS.append(f"{block_id}.{param['id']}: {default} -> {options[0]}")
    return options[0]


def clean_doxygen(comment):
    """Turn one /** ... */ comment into readable, plain-text documentation."""
    text = re.sub(r"^/\*[*!]|(?:\*/)$", "", comment.strip())
    lines = [re.sub(r"^\s*\*\s?", "", line).rstrip() for line in text.splitlines()]
    output = []
    params = []
    current_param = None
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if output and output[-1] != "":
                output.append("")
            current_param = None
            continue
        command = re.match(r"^[\\@](\w+)(?:\[[^]]+\])?\s*(.*)$", stripped)
        if command:
            name, rest = command.groups()
            if name in ("ingroup", "addtogroup", "defgroup", "private", "public"):
                continue
            if name == "param":
                param = re.match(r"(\S+)\s*(.*)", rest)
                if param:
                    current_param = [param.group(1), param.group(2)]
                    params.append(current_param)
                continue
            current_param = None
            labels = {
                "brief": "", "details": "", "note": "Note: ", "warning": "Warning: ",
                "return": "Returns: ", "returns": "Returns: ", "see": "See: ",
                "throws": "Throws: ", "exception": "Throws: ",
            }
            if name in labels:
                stripped = labels[name] + rest
            elif name in ("code", "endcode", "f", "f$", "f[", "f]"):
                continue
        elif current_param:
            current_param[1] = (current_param[1] + " " + stripped).strip()
            continue

        # Doxygen inline formatting has no useful equivalent in a text-only
        # panel. Preserve its argument and discard the presentation command.
        stripped = re.sub(r"[\\@](?:a|p|c|e|em|b)\s+([A-Za-z_]\w*)", r"\1", stripped)
        stripped = re.sub(r"[\\@]ref\s+([^\s]+)", r"\1", stripped)
        stripped = stripped.replace(r"\f$", "").replace(r"\f[", "").replace(r"\f]", "")
        if stripped:
            output.append(stripped)
    while output and output[-1] == "":
        output.pop()
    if params:
        if output:
            output.extend(["", "Parameters:"])
        else:
            output.append("Parameters:")
        output.extend(
            "  " + name + (": " + description if description else "")
            for name, description in params
        )
    return "\n".join(output).strip()


CLASS_DOC_RE = re.compile(
    r"(/\*[*!][\s\S]*?\*/)[ \t\r\n]*"
    r"(?:template\s*<[\s\S]*?>[ \t\r\n]*)?"
    r"(?:class|struct)\s+(?:[A-Z][A-Z0-9_]*_API\s+)?([A-Za-z_]\w*)"
)
MAKE_DOC_RE = re.compile(
    r"(/\*[*!][\s\S]*?\*/)[ \t\r\n]*"
    r"static\s+(?:[A-Za-z_:<>]+\s+)*sptr\s+make\s*\("
)


def extract_cpp_doc(block):
    """Extract the class/constructor docs used to generate native docstrings."""
    cpp_templates = block.get("cpp_templates") or {}
    includes = cpp_templates.get("includes") or []
    if isinstance(includes, str):
        includes = [includes]
    include_names = []
    for include_text in includes:
        for include in re.findall(r"#include\s*[<\"]([^>\"]+)[>\"]", str(include_text)):
            include_names.extend(expand_include_template(include, block))

    for include in include_names:
        path = resolve_header(include)
        if not path:
            continue
        try:
            source = open(path, encoding="utf-8").read()
        except (OSError, UnicodeError):
            continue
        stem = os.path.splitext(os.path.basename(path))[0]
        class_matches = list(CLASS_DOC_RE.finditer(source))
        class_match = next((match for match in class_matches if match.group(2) == stem),
                           class_matches[0] if len(class_matches) == 1 else None)
        if not class_match:
            continue
        docs = [clean_doxygen(class_match.group(1))]
        class_body = source[class_match.end():]
        make_match = MAKE_DOC_RE.search(class_body)
        if make_match:
            docs.append(clean_doxygen(make_match.group(1)))
        docs = [doc for doc in docs if doc]
        if docs:
            # Doxygen commonly repeats the brief sentence on class and make().
            return "\n\n".join(dict.fromkeys(docs))
    return ""


PYTHON_DOC_CACHE = {}


def python_docs(module):
    if module in PYTHON_DOC_CACHE:
        return PYTHON_DOC_CACHE[module]
    docs = {}
    roots = [
        os.path.join(GR, "gr-" + module, "python"),
        os.path.join(WORLD, "gr-" + module, "python"),
    ]
    configured_root = MODULE_SOURCE_ROOTS.get("gr-" + module)
    if configured_root:
        roots.append(os.path.join(configured_root, "python"))
    for root in roots:
        for path in sorted(glob.glob(os.path.join(root, "**", "*.py"), recursive=True)):
            try:
                tree = ast.parse(open(path, encoding="utf-8").read(), filename=path)
            except (OSError, UnicodeError, SyntaxError):
                continue
            for node in tree.body:
                if not isinstance(node, (ast.ClassDef, ast.FunctionDef)):
                    continue
                doc = (ast.get_docstring(node, clean=True) or "").strip()
                if doc:
                    docs.setdefault(node.name, doc)
    PYTHON_DOC_CACHE[module] = docs
    return docs


def extract_python_doc(block, block_id):
    """Read literal Python hierarchy/widget docstrings without importing them."""
    templates = block.get("templates") or {}
    make = str(templates.get("make") or "")
    imports = str(templates.get("imports") or "")
    calls = re.findall(r"\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\s*\(", make)
    names = [call.rsplit(".", 1)[-1] for call in calls]
    modules = re.findall(r"from\s+gnuradio\s+import\s+([A-Za-z_]\w*)", imports)
    modules += [call.split(".", 1)[0] for call in calls]
    modules.append(block_id.split("_", 1)[0])
    for module in dict.fromkeys(modules):
        prefix = module + "_"
        if block_id.startswith(prefix):
            names.append(block_id[len(prefix):])
        docs = python_docs(module)
        for name in dict.fromkeys(names):
            if name in docs:
                return docs[name]
    return ""


def walk_tree(node, path, out):
    """Walk a GRC .tree.yml node, mapping block-id -> category path list."""
    if isinstance(node, dict):
        for name, children in node.items():
            walk_tree(children, path + [str(name)], out)
    elif isinstance(node, list):
        for item in node:
            walk_tree(item, path, out)
    elif isinstance(node, str):
        # This matches grc.core.platform: later appearances in a tree replace
        # earlier ones (some native trees intentionally list a block twice).
        out[node] = list(path)


def load_categories():
    """block-id -> native category path from every module's *.tree.yml."""
    cats = {}
    for mod in MODULES:
        for f in sorted(glob.glob(os.path.join(mod, "*.tree.yml"))):
            try:
                walk_tree(yaml.safe_load(open(f)), [], cats)
            except Exception:
                pass
    return cats


def normalize_category(category):
    """Apply the same root-category rules as grc.core.platform."""
    if not category:
        return None
    if isinstance(category, str):
        parts = [part.strip() for part in category.split("/") if part.strip()]
    else:
        parts = [str(part).strip() for part in category if str(part).strip()]
    if not parts:
        return None
    if parts[0].startswith("[") and parts[0].endswith("]"):
        parts[0] = parts[0][1:-1]
    else:
        parts.insert(0, "Core")
    return parts


def port_list(items):
    out = []
    for p in items or []:
        if not isinstance(p, dict):
            continue
        port = {"id": str(p.get("id", "")),
                "label": p.get("label", ""),
                "domain": p.get("domain", "stream"),
                "dtype": str(p.get("dtype", "")),
                "multiplicity": str(p.get("multiplicity", "1")),
                "optional": p.get("optional", False)}
        # These are absent on most ports; preserve them only where native GRC
        # has dynamic vector lengths or visibility to keep blocks.json compact.
        if "vlen" in p:
            port["vlen"] = str(p["vlen"])
        if "hide" in p:
            port["hide"] = p["hide"]
        out.append(port)
    return out

def main(out_path):
    categories = load_categories()
    manifest = json.load(open(MANIFEST))
    supported = set(manifest["supported"])
    skipped = manifest.get("skipped", {})
    # Blocks whose factory builds a QWidget, and so take a tile in the runner
    # window. Declared per block as `gui: true` (in its overlay, or in its own
    # yml for a runner-only block); gen_registry.py collects them into `gui`.
    gui = set(manifest.get("gui", []))
    # id -> deferred category side module (fetched on demand). Blocks absent from
    # this map live in the always-loaded core module.
    block_module = manifest.get("block_module", {})
    # Parameters the running flowgraph can still change: the ones whose factory
    # installed a numeric setter, which gen_registry.py reads back out of the
    # C++ it generates and out of registry.cpp's hand-written table. Native GRC
    # underlines the same idea in its Properties dialog, taking it from the
    # yaml `callbacks:` -- but a callback this runtime never rendered is not a
    # parameter that can be changed here, so the factory is the authority.
    live_params = manifest.get("live_params", {})
    blocks_by_id = {}
    for mod in MODULES:
        # Source provenance is deliberately separate from `block_module` above:
        # the latter names a downloadable WASM chunk and therefore says "core"
        # for an unavailable OOT block. The source directory still tells us that
        # block belongs to (say) gr-ham, whether or not it has a runnable factory.
        oot_module = OOT_MODULE_BY_DIR.get(mod)
        # Recursive: gr-satellites groups its block metadata into grc/
        # subdirectories (components/deframers, hier, ccsds, ...); every other
        # module keeps grc/ flat, so the recursive walk costs nothing there.
        for f in sorted(glob.glob(os.path.join(mod, "**", "*.block.yml"),
                                 recursive=True)):
            try:
                d = yaml.safe_load(open(f))
            except Exception:
                continue
            if not isinstance(d, dict) or "id" not in d:
                continue
            block_id = str(d["id"])
            override = BLOCK_OVERRIDES.get(block_id)
            if override:
                block_overrides.apply(d, override)
                if override.get("hidden"):
                    continue
            # A module's .tree.yml normally decides the category, as in native
            # GRC. An overlay `category` is a deliberate browser-only
            # recategorization, and a runner-owned definition has no upstream
            # tree of its own, so either one outranks a coincidentally matching
            # native tree entry (notably the synthesized epy_block). gr-dvbs2rx
            # uses the overlay case to retain a concise DVB-S2 RX subcategory
            # beneath the generated OOT root.
            if (override and "category" in override) or mod == WORLD_BLOCKS:
                block_category = normalize_category(d.get("category"))
            else:
                block_category = normalize_category(
                    categories.get(block_id, d.get("category")))
            # Keep the native category whenever one exists. A few upstream
            # definitions are accidentally uncategorized; retain them under a
            # small fallback so runnable blocks never disappear from the web UI.
            if not block_category:
                block_category = ["Core", "Other"]
            # An OOT's upstream category is often a domain name unrelated to the
            # package a user must install. Keep useful subcategories, but make the
            # package itself the stable palette root: Ham -> gr-ham, and
            # Satellites/Deframers -> gr-satellites/Deframers.
            if oot_module:
                block_category[0] = oot_module
            params = []
            param_categories = {}
            live = set(live_params.get(block_id, []))
            for p in d.get("parameters", []) or []:
                if isinstance(p, dict) and "id" in p:
                    param_category = p.get("category")
                    if not param_category and p.get("base_key"):
                        param_category = param_categories.get(p["base_key"])
                    param_category = param_category or "General"
                    param_categories[p["id"]] = param_category
                    params.append({"id": p["id"], "label": p.get("label", p["id"]),
                                   "dtype": str(p.get("dtype", "")),
                                   "default": enum_default(block_id, p),
                                   "category": param_category,
                                   "options": python_options(p.get("options")),
                                   "option_labels": p.get("option_labels"),
                                   "option_attributes": p.get("option_attributes"),
                                   "hide": p.get("hide", "none")}
                                  # Only when true: this is one key on every
                                  # parameter of every block, and blocks.json is
                                  # already a 2 MB download.
                                  | ({"live": True} if p["id"] in live else {}))
            flags = d.get("flags", []) or []
            runnable = block_id in supported
            documentation = str(d.get("documentation") or "").strip()
            api_documentation = (
                extract_cpp_doc(d) or extract_python_doc(d, block_id)
            ) if runnable else ""
            doc_url = str(d.get("doc_url") or "").strip()
            if doc_url:
                wiki_url = urljoin(WIKI_BLOCK_DOCS_URL_PREFIX, doc_url)
            elif block_category[0] == "Core":
                wiki_url = urljoin(
                    WIKI_BLOCK_DOCS_URL_PREFIX,
                    str(d.get("label", block_id)).replace(" ", "_"),
                )
            else:
                wiki_url = ""
            if runnable:
                unavailable_reason = None
            elif block_id in skipped:
                unavailable_reason = skipped[block_id]
            elif "python" in flags and "cpp" not in flags:
                unavailable_reason = "Python-only block"
            else:
                unavailable_reason = "not implemented in the WebAssembly runner"
            blocks_by_id[block_id] = {
                "id": block_id, "label": d.get("label", block_id),
                "category": block_category,
                "flags": d.get("flags", []),
                "runnable": runnable,
                "unavailable_reason": unavailable_reason,
                # Occupies a tile in the runner window's GUI Layout grid.
                "gui": block_id in gui,
                # Which downloadable chunk supplies this block's code; "core" is
                # always present, others are fetched on first use.
                "module": block_module.get(block_id, "core"),
                # The vendored source package, independent of runtime support.
                # In-tree and browser-owned blocks carry null here.
                "oot_module": oot_module,
                # Native GRC shows the YAML prose followed by the Python binding
                # docstring. The latter comes from C++ Doxygen or a Python
                # hierarchy/widget docstring, so keep the sources separate.
                "documentation": documentation,
                "api_documentation": api_documentation,
                "wiki_url": wiki_url,
                "params": params,
                "inputs": port_list(d.get("inputs")),
                "outputs": port_list(d.get("outputs")),
            }
    blocks = list(blocks_by_id.values())
    output_dir = os.path.dirname(out_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    json.dump({"blocks": blocks}, open(out_path, "w"), indent=1)
    print(f"wrote {len(blocks)} blocks -> {out_path}")
    if REPAIRED_DEFAULTS:
        print(f"  {len(REPAIRED_DEFAULTS)} enum defaults were not among their own "
              f"options and were repaired (see enum_default):")
        for repair in REPAIRED_DEFAULTS:
            print(f"    {repair}")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "blocks.json")
