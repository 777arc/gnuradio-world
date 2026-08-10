# The `gnuradio` namespace inside the browser's Python runtime.
#
# Only `gnuradio.gr` exists, and only the part of it a Python Block's own source
# needs (see gnuradio/gr/__init__.py). `gnuradio.blocks`, `gnuradio.analog` and
# the rest are C++ extension modules in desktop GNU Radio; here those blocks live
# in the runner's WebAssembly instance and are placed on the canvas instead.

__all__ = ["gr"]

_UNAVAILABLE = (
    "gnuradio.{0} is not available in the browser runner -- it is a C++ extension "
    "module in desktop GNU Radio. Only gnuradio.gr (the Python Block base classes) "
    "is importable here; place {0} blocks on the flowgraph canvas instead."
)


def __getattr__(name):
    raise AttributeError(_UNAVAILABLE.format(name))
