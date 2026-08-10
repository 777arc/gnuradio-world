# The `gnuradio.gr` a Python Block sees in the browser runner.
#
# Upstream this module re-exports a large pybind11 extension (gr_python) plus the
# gateway classes. Here only the gateway exists: a Python Block's source is
# Python, so it needs the block base classes, the io-signature helper, the
# constants and the tag type -- and nothing else in `gr` is reachable from
# Pyodide, because the DSP blocks live in the runner's separate WASM instance.
#
# Anything absent raises on attribute access with a message that says so, rather
# than an AttributeError that reads like a typo in the user's own code.

from .gateway import (  # noqa: F401
    GW_BLOCK_DECIM,
    GW_BLOCK_GENERAL,
    GW_BLOCK_INTERP,
    GW_BLOCK_SYNC,
    TPP_ALL_TO_ALL,
    TPP_CUSTOM,
    TPP_DONT,
    TPP_ONE_TO_ONE,
    WORK_CALLED_PRODUCE,
    WORK_DONE,
    basic_block,
    decim_block,
    gateway_block,
    interp_block,
    py_io_signature,
    sizeof_char,
    sizeof_double,
    sizeof_float,
    sizeof_gr_complex,
    sizeof_int,
    sizeof_short,
    sync_block,
)
from . import gateway  # noqa: F401  (epy_block_io looks up gr.gateway.gateway_block)
from .tags import PythonTag, Tag, python_to_tag, tag_to_python  # noqa: F401


class io_signature(object):
    """
    Minimal stand-in. A gateway block's ports come from its numpy in_sig/out_sig,
    so this exists only for source compatibility with a block that mentions it.
    """

    @staticmethod
    def make(min_streams, max_streams, sizeof_stream_item):
        return (min_streams, max_streams, [sizeof_stream_item])

    @staticmethod
    def makev(min_streams, max_streams, sizeof_stream_items):
        return (min_streams, max_streams, list(sizeof_stream_items))

    @staticmethod
    def make2(min_streams, max_streams, size1, size2):
        return (min_streams, max_streams, [size1, size2])

    @staticmethod
    def make3(min_streams, max_streams, size1, size2, size3):
        return (min_streams, max_streams, [size1, size2, size3])


_UNAVAILABLE = (
    "gnuradio.gr.{0} is not available in the browser runner: the GNU Radio C++ "
    "runtime runs in a separate WebAssembly instance that Python cannot reach. A "
    "Python Block can use the block base classes (gr.sync_block, gr.basic_block, "
    "gr.decim_block, gr.interp_block), numpy and the standard library. Build the "
    "rest of the flowgraph out of blocks on the canvas."
)


def __getattr__(name):
    raise AttributeError(_UNAVAILABLE.format(name))
