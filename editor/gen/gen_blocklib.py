#!/usr/bin/env python3
"""Generate the editor's block-library JSON from GNU Radio .block.yml files.
Build-time only (no Python at runtime). Emits id/label/category/params/ports so
the TS editor can render a palette and property dialogs."""
import sys, os, json, glob, yaml

# Repo root derived from this script's location (wasm/editor/gen/ -> repo root),
# so the generator works regardless of checkout path (local or CI).
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
# Mirror the native GRC block search across every in-tree module. HEIR is
# intentionally excluded from the WASM product, but all other definitions are
# emitted so unavailable blocks can remain visible in the library.
MODULES = ["grc/blocks"] + [
    os.path.relpath(path, REPO)
    for path in sorted(glob.glob(os.path.join(REPO, "gr-*", "grc")))
    if os.path.basename(os.path.dirname(path)) != "gr-heir"
]
MANIFEST = os.path.join(REPO, "wasm/runner/generated_blocks.json")

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
        for f in sorted(glob.glob(os.path.join(REPO, mod, "*.tree.yml"))):
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
    return "/".join(parts)


def port_list(items):
    out = []
    for p in items or []:
        if not isinstance(p, dict):
            continue
        out.append({"id": str(p.get("id", "")),
                    "label": p.get("label", ""),
                    "domain": p.get("domain", "stream"),
                    "dtype": str(p.get("dtype", "")),
                    "multiplicity": str(p.get("multiplicity", "1")),
                    "optional": p.get("optional", False)})
    return out

def main(out_path):
    categories = load_categories()
    manifest = json.load(open(MANIFEST))
    supported = set(manifest["supported"])
    skipped = manifest.get("skipped", {})
    # id -> deferred category side module (fetched on demand). Blocks absent from
    # this map live in the always-loaded core module.
    block_module = manifest.get("block_module", {})
    blocks_by_id = {}
    for mod in MODULES:
        for f in sorted(glob.glob(os.path.join(REPO, mod, "*.block.yml"))):
            try:
                d = yaml.safe_load(open(f))
            except Exception:
                continue
            if not isinstance(d, dict) or "id" not in d:
                continue
            block_id = str(d["id"])
            block_category = normalize_category(categories.get(block_id, d.get("category")))
            # Keep the native category whenever one exists. A few upstream
            # definitions are accidentally uncategorized; retain them under a
            # small fallback so runnable blocks never disappear from the web UI.
            if not block_category:
                block_category = "Core/Other"
            params = []
            param_categories = {}
            for p in d.get("parameters", []) or []:
                if isinstance(p, dict) and "id" in p:
                    param_category = p.get("category")
                    if not param_category and p.get("base_key"):
                        param_category = param_categories.get(p["base_key"])
                    param_category = param_category or "General"
                    param_categories[p["id"]] = param_category
                    params.append({"id": p["id"], "label": p.get("label", p["id"]),
                                   "dtype": str(p.get("dtype", "")),
                                   "default": p.get("default", ""),
                                   "category": param_category,
                                   "options": p.get("options"),
                                   "option_labels": p.get("option_labels"),
                                   "option_attributes": p.get("option_attributes"),
                                   "hide": p.get("hide", "none")})
            flags = d.get("flags", []) or []
            runnable = block_id in supported
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
                # Which downloadable chunk supplies this block's code; "core" is
                # always present, others are fetched on first use.
                "module": block_module.get(block_id, "core"),
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

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "blocks.json")
