"""Browser-only block metadata overlays, shared by the runtime and palette generators.

GRC block metadata lives in each module's ``.block.yml``, but the browser build
needs additions upstream does not carry: ``cpp_templates`` for the C++ factory
generator, retyped parameters, and pruned enum options.  Keeping those overlays
here rather than in the module sources means every submodule -- in-tree GNU Radio
and out-of-tree alike -- can stay pinned to a pristine upstream commit.

Every overlay lives under ``blocks/overlays/<module>/metadata.yml``, one
directory per module, and ``load()`` reads them all:

``blocks/overlays/gr-<m>/metadata.yml``
    One out-of-tree module's block metadata.  A block id here must belong to
    ``gr-<m>``; ``validate()`` enforces that, so the file stays a complete
    account of one module.  Its directory holds that module's other browser-side
    additions too -- ``shims/`` for the headers that stand in for host-only
    dependencies, and any C++ rebuilt from a Python-only block.

``blocks/overlays/gnuradio/metadata.yml``
    The same overlays for blocks in the GNU Radio tree itself.  It is the one
    directory whose ids are not checked against a single module, because that
    submodule *is* many modules (gr-blocks, gr-analog, ...).  C++ for the
    in-tree rebuilds lives in ``blocks/src/`` rather than here, for the same
    reason: there is no one module to attribute it to.

Both generators must apply these identically -- the runtime factory and the
palette entry describing it are only in agreement because they come from the same
merge.  Hence one ``apply()``, imported by both, rather than a copy on each side.

Supported keys, all optional except where an entry would otherwise do nothing:

``flags``
    Replaces the block's flags.  ``[python, cpp]`` is what makes the generator
    emit a factory at all.
``category``
    Replaces the palette category, for a module whose upstream category collides
    with an in-tree one.
``documentation``
    Replaces the prose the Properties dialog shows under "Block description".
    For a block the browser build implements differently enough that upstream's
    own description would mislead -- gr-paint's Image File Source takes a URL and
    is subject to the page's CORS rules, neither of which upstream can mention.
``cpp_templates``
    The GRC C++ template mapping the factory generator renders.
``parameter_dtypes`` / ``parameter_defaults`` / ``parameter_labels``
    Retype, re-default or relabel one parameter by id.  Retyping is used where
    upstream's dtype is ``raw`` holding an expression the generator cannot type
    (a ``pmt.intern(...)`` call becomes a plain ``string`` the template wraps
    itself).  Relabelling is for a parameter the browser build gives a different
    meaning: gr-paint's Image File Source names a URL, not a local file.
``prune_options``
    Drop enum options the WASM build cannot name -- an enumerator absent from the
    vendored C++ enum fails the side-module compile.  Takes option *values* and
    removes each one's entry from ``options``, ``option_labels`` and every list
    under ``option_attributes``, which pair positionally.  Doing it here rather
    than by hand in the yaml is what keeps those three lists aligned.
"""

from __future__ import annotations

import os
from typing import Any

import yaml

WORLD = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OVERLAY_DIR = os.path.join(WORLD, "blocks", "overlays")
METADATA = "metadata.yml"
# The in-tree submodule's overlay directory. Its ids span every gr-* under
# gnuradio/, so validate() cannot pin them to one module the way it does for OOT.
IN_TREE_MODULE = "gnuradio"

KEYS = {"flags", "category", "cpp_templates", "documentation",
        "parameter_dtypes", "parameter_defaults", "parameter_labels",
        "prune_options"}


def _read(path: str) -> dict[str, Any]:
    try:
        with open(path) as fh:
            return yaml.safe_load(fh) or {}
    except FileNotFoundError:
        return {}


def load() -> dict[str, dict[str, Any]]:
    """All overlays, keyed by block id, with the module each id must belong to
    recorded under ``__module`` for validate().

    A block id appearing in two files is an error rather than last-one-wins: the
    loser would apply nowhere and leave no trace, which is the same silent
    failure validate() exists to prevent.

    An overlay directory is discovered by its name alone, so adding a module is
    adding a directory -- there is no list here to keep in step with it.
    """
    overrides: dict[str, dict[str, Any]] = {}
    duplicates = []
    sources = []
    for directory in sorted(os.listdir(OVERLAY_DIR)):
        path = os.path.join(OVERLAY_DIR, directory, METADATA)
        if not os.path.isdir(os.path.join(OVERLAY_DIR, directory)):
            continue
        # Discovery is by directory, so a misnamed metadata file would leave the
        # whole module silently un-overlaid. Say so instead.
        if not os.path.isfile(path):
            raise SystemExit(
                f"block override errors:\n  blocks/overlays/{directory}/ has no "
                f"{METADATA}")
        module = (None if directory == IN_TREE_MODULE
                  else directory[len("gr-"):] if directory.startswith("gr-")
                  else directory)
        sources.append((module, path))
    for module, path in sources:
        for block_id, entry in _read(path).items():
            rel = os.path.relpath(path, WORLD)
            if block_id in overrides:
                duplicates.append(
                    f"'{block_id}' is defined in both "
                    f"{overrides[block_id]['__source']} and {rel}")
            entry = dict(entry)
            entry["__module"] = module
            entry["__source"] = rel
            overrides[block_id] = entry
    if duplicates:
        raise SystemExit("block override errors:\n  " + "\n  ".join(duplicates))
    return overrides


def apply(block: dict[str, Any], override: dict[str, Any]) -> None:
    """Merge one overlay into a parsed .block.yml, in place."""
    block["flags"] = override.get("flags", block.get("flags") or [])
    if "category" in override:
        block["category"] = override["category"]
    if "documentation" in override:
        block["documentation"] = override["documentation"]
    block["cpp_templates"] = override.get(
        "cpp_templates", block.get("cpp_templates") or {})

    dtypes = override.get("parameter_dtypes") or {}
    defaults = override.get("parameter_defaults") or {}
    labels = override.get("parameter_labels") or {}
    prune = override.get("prune_options") or {}
    for param in block.get("parameters") or []:
        if not isinstance(param, dict):
            continue
        pid = param.get("id")
        if pid in dtypes:
            param["dtype"] = dtypes[pid]
        if pid in defaults:
            param["default"] = defaults[pid]
        if pid in labels:
            param["label"] = labels[pid]
        if pid in prune:
            _prune_options(block, param, prune[pid])


def _prune_options(block: dict[str, Any], param: dict[str, Any],
                   drop: list[Any]) -> None:
    """Remove `drop` from a parameter's options, and the same positions from
    every list that pairs with it."""
    options = param.get("options") or []
    keep = [i for i, opt in enumerate(options) if opt not in drop]
    missing = [d for d in drop if d not in options]
    if missing:
        raise SystemExit(
            f"{block['id']}.{param['id']}: prune_options names option(s) the "
            f"block does not have: {', '.join(map(str, missing))}")
    if param.get("default") in drop:
        raise SystemExit(
            f"{block['id']}.{param['id']}: prune_options drops the parameter's "
            f"own default ({param['default']})")

    def take(seq: list[Any]) -> list[Any]:
        return [seq[i] for i in keep] if len(seq) == len(options) else seq

    param["options"] = take(options)
    if isinstance(param.get("option_labels"), list):
        param["option_labels"] = take(param["option_labels"])
    for name, values in (param.get("option_attributes") or {}).items():
        if isinstance(values, list):
            param["option_attributes"][name] = take(values)


def validate(overrides: dict[str, Any], seen: dict[str, str]) -> None:
    """Fail on an overlay that silently did nothing.

    ``seen`` maps every block id the generator actually loaded to its module.  An
    id absent from it is a typo, and a typo is invisible otherwise: the merge is a
    dict lookup, so a misspelled id just never applies and the block quietly stays
    Python-only (greyed out in the palette, missing from the runtime) with no
    error anywhere.  An id in the wrong ``gr-<m>.yml`` is the same class of
    mistake and would make that file an incomplete account of its module.
    """
    problems = []
    for block_id, entry in sorted(overrides.items()):
        source = entry.get("__source", "?")
        module = entry.get("__module")
        if block_id not in seen:
            problems.append(f"{source}: '{block_id}' matches no known block")
        elif module and seen[block_id] != module:
            problems.append(
                f"{source}: '{block_id}' belongs to gr-{seen[block_id]}, "
                f"not gr-{module}")
        for key in sorted(set(entry) - KEYS - {"__module", "__source"}):
            problems.append(f"{source}: '{block_id}' has unknown key '{key}'")
    if problems:
        raise SystemExit("block override errors:\n  " + "\n  ".join(problems))
