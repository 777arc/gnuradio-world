#!/usr/bin/env python3
"""Generate the editor's block-library JSON from GNU Radio .block.yml files.
Build-time only (no Python at runtime). Emits id/label/category/params/ports so
the TS editor can render a palette and property dialogs."""
import sys, os, json, glob, yaml

REPO = "/home/marc/gnuradio"
MODULES = ["grc/blocks", "gr-blocks/grc", "gr-analog/grc", "gr-fft/grc",
           "gr-filter/grc", "gr-qtgui/grc", "gr-digital/grc"]

def walk_tree(node, path, out):
    """Walk a GRC .tree.yml node, mapping block-id -> category path list."""
    if isinstance(node, dict):
        for name, children in node.items():
            walk_tree(children, path + [str(name)], out)
    elif isinstance(node, list):
        for item in node:
            walk_tree(item, path, out)
    elif isinstance(node, str):
        out.setdefault(node, path)  # first category wins


def load_categories():
    """block-id -> 'Cat/Sub' from every module's *.tree.yml."""
    cats = {}
    for mod in MODULES:
        for f in glob.glob(os.path.join(REPO, mod, "*.tree.yml")):
            try:
                walk_tree(yaml.safe_load(open(f)), [], cats)
            except Exception:
                pass
    # display: strip the [brackets] GRC uses on the root (e.g. '[Core]' -> 'Core')
    return {bid: "/".join(p).replace("[", "").replace("]", "") for bid, p in cats.items()}


def port_list(items):
    out = []
    for p in items or []:
        if not isinstance(p, dict):
            continue
        out.append({"label": p.get("label", ""),
                    "domain": p.get("domain", "stream"),
                    "dtype": str(p.get("dtype", ""))})
    return out

def main(out_path):
    categories = load_categories()
    blocks = []
    for mod in MODULES:
        for f in sorted(glob.glob(os.path.join(REPO, mod, "*.block.yml"))):
            try:
                d = yaml.safe_load(open(f))
            except Exception:
                continue
            if not isinstance(d, dict) or "id" not in d:
                continue
            params = []
            for p in d.get("parameters", []) or []:
                if isinstance(p, dict) and "id" in p:
                    params.append({"id": p["id"], "label": p.get("label", p["id"]),
                                   "dtype": str(p.get("dtype", "")),
                                   "default": p.get("default", ""),
                                   "options": p.get("options"),
                                   "option_labels": p.get("option_labels")})
            cat = categories.get(d["id"]) or d.get("category", "") or "Other"
            if isinstance(cat, list):
                cat = "/".join(str(c) for c in cat)
            cat = cat.replace("[", "").replace("]", "").strip("/") or "Other"
            blocks.append({
                "id": d["id"], "label": d.get("label", d["id"]),
                "category": cat,
                "flags": d.get("flags", []),
                "params": params,
                "inputs": port_list(d.get("inputs")),
                "outputs": port_list(d.get("outputs")),
            })
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump({"blocks": blocks}, open(out_path, "w"), indent=1)
    print(f"wrote {len(blocks)} blocks -> {out_path}")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "blocks.json")
