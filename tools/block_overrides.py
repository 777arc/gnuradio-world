"""Browser-only block metadata overlays, shared by the runtime and palette generators.

GRC block metadata lives in each module's ``.block.yml``, but the browser build
needs additions upstream does not carry: ``cpp_templates`` for the C++ factory
generator, retyped parameters, and pruned enum options.  Keeping those overlays
here rather than in the module sources means every submodule -- in-tree GNU Radio
and out-of-tree alike -- can stay pinned to a pristine upstream commit.

Two sources are merged, both read by ``load()``:

``runner/oot_cpp_templates/gr-<m>.yml``
    One file per out-of-tree module, holding every browser-only addition for it.
    A block id here must belong to ``gr-<m>``; ``validate()`` enforces that, so a
    file stays a complete account of one module.

``runner/block_overrides.yml``
    The same overlays for blocks in the GNU Radio tree itself, which has no
    per-module file because it is one submodule.

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
``cpp_templates``
    The GRC C++ template mapping the factory generator renders.
``parameter_dtypes`` / ``parameter_defaults``
    Retype or re-default one parameter by id.  Used where upstream's dtype is
    ``raw`` holding an expression the generator cannot type (a ``pmt.intern(...)``
    call becomes a plain ``string`` the template wraps itself).
``prune_options``
    Drop enum options the WASM build cannot name -- an enumerator absent from the
    vendored C++ enum fails the side-module compile.  Takes option *values* and
    removes each one's entry from ``options``, ``option_labels`` and every list
    under ``option_attributes``, which pair positionally.  Doing it here rather
    than by hand in the yaml is what keeps those three lists aligned.
"""

from __future__ import annotations

import glob
import os
from typing import Any

import yaml

WORLD = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OOT_DIR = os.path.join(WORLD, "runner", "oot_cpp_templates")
IN_TREE_PATH = os.path.join(WORLD, "runner", "block_overrides.yml")

KEYS = {"flags", "category", "cpp_templates", "parameter_dtypes",
        "parameter_defaults", "prune_options"}


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
    """
    overrides: dict[str, dict[str, Any]] = {}
    duplicates = []
    sources = [(os.path.basename(p)[len("gr-"):-len(".yml")], p)
               for p in sorted(glob.glob(os.path.join(OOT_DIR, "gr-*.yml")))]
    sources.append((None, IN_TREE_PATH))
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
    block["cpp_templates"] = override.get(
        "cpp_templates", block.get("cpp_templates") or {})

    dtypes = override.get("parameter_dtypes") or {}
    defaults = override.get("parameter_defaults") or {}
    prune = override.get("prune_options") or {}
    for param in block.get("parameters") or []:
        if not isinstance(param, dict):
            continue
        pid = param.get("id")
        if pid in dtypes:
            param["dtype"] = dtypes[pid]
        if pid in defaults:
            param["default"] = defaults[pid]
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
