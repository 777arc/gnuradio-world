# The host side of an Embedded Python Block, inside Pyodide.
#
# Two jobs, one module:
#
#   introspect(source)  -- what the editor calls to derive a block's label,
#                          parameters, ports and callbacks from its source. This
#                          is a port of gnuradio/grc/core/utils/epy_block_io.py,
#                          extended with the things a browser host must know
#                          *before* it can build the C++ block (history, output
#                          multiple, relative rate, message ports).
#
#   create/work/...     -- what the runner calls per flowgraph and then per
#                          scheduler call. See docs/embedded-python.md for the
#                          handshake this sits at the far end of.
#
# Nothing here is imported by the user's source; it is the harness around it.

import inspect

import numpy

try:
    import js
    from pyodide.ffi import to_js
except ImportError:
    # Not running under Pyodide. Everything below except the two conversion
    # helpers is plain Python, so this fallback is what lets the introspection
    # and work-call semantics be tested by a host CPython run --
    # runner/test/test_grworld.py -- instead of only in a browser.
    js = None

    def to_js(value, dict_converter=None):
        return value

from gnuradio import gr
from gnuradio.gr.gateway import GW_BLOCK_GENERAL, WORK_CALLED_PRODUCE, gateway_block

# numpy dtype name -> GRC port type. Same table as upstream's epy_block_io, and
# with the same consequence: float64/complex128 are absent, so `np.float64` in an
# in_sig is an error rather than a silently mistyped port.
TYPE_MAP = {
    'complex64': 'complex', 'complex': 'complex',
    'float32': 'float', 'float': 'float',
    'int32': 'int', 'uint32': 'int',
    'int16': 'short', 'uint16': 'short',
    'int8': 'byte', 'uint8': 'byte',
}

_BLOCK_TYPE_NAMES = {
    gr.GW_BLOCK_GENERAL: 'general',
    gr.GW_BLOCK_SYNC: 'sync',
    gr.GW_BLOCK_DECIM: 'decim',
    gr.GW_BLOCK_INTERP: 'interp',
}

# The four base classes themselves are never the user's block. Upstream scans the
# exec'd namespace for the first subclass of gateway_block, which picks up
# `sync_block` itself if the source says `from gnuradio.gr import sync_block`
# (the import lands in the namespace before the class definition does). Excluding
# the bases costs nothing and removes that trap.
_BASE_CLASSES = (gateway_block, gr.basic_block, gr.sync_block, gr.decim_block, gr.interp_block)
_BASE_FORECASTS = tuple(cls.forecast for cls in _BASE_CLASSES)


def _ports(sigs):
    """Stream ports from an io signature, as (id, grc_type, vlen) triples."""
    ports = []
    for i, dtype in enumerate(sigs):
        port_type = TYPE_MAP.get(dtype.base.name, None)
        if not port_type:
            raise ValueError("Can't map {0!r} to a GRC port type".format(dtype))
        vlen = dtype.shape[0] if len(dtype.shape) > 0 else 1
        ports.append((str(i), port_type, int(vlen)))
    return ports


def _find_block_class(source_code):
    namespace = {}
    exec(source_code, namespace)
    for value in namespace.values():
        if (inspect.isclass(value) and issubclass(value, gateway_block)
                and value not in _BASE_CLASSES):
            return value
    raise ValueError(
        'No Python block class found in the code: it must define a class deriving '
        'from gr.sync_block, gr.basic_block, gr.decim_block or gr.interp_block.')


def _init_args(cls):
    """
    The block's parameters, as (name, repr-of-default) pairs. Checked before the
    class is instantiated, so a signature GRC could not turn into parameters
    reports upstream's message rather than a TypeError from the constructor.
    """
    spec = inspect.getfullargspec(cls.__init__)
    init_args = spec.args[1:]
    defaults = [repr(arg) for arg in (spec.defaults or ())]
    if len(defaults) + 1 != len(spec.args):
        raise ValueError("Need all __init__ arguments to have default values")
    return init_args, defaults


def _describe(cls, instance):
    """The editor's and the runner's view of an instantiated block."""
    init_args, defaults = _init_args(cls)

    def settable(attr):
        try:
            return callable(getattr(cls, attr).fset)  # a property with a setter
        except AttributeError:
            return attr in instance.__dict__  # a plain instance attribute
    callbacks = [attr for attr in dir(instance) if attr in init_args and settable(attr)]

    gateway = instance.gateway
    declaration = gateway.declaration()
    in_sig, out_sig = instance.in_sig(), instance.out_sig()
    described = {
        'cls': cls.__name__,
        'label': gateway.name() or cls.__name__,
        'doc': cls.__doc__ or cls.__init__.__doc__ or '',
        'params': [list(pair) for pair in zip(init_args, defaults)],
        'callbacks': callbacks,
        'sinks': [list(p) for p in _ports(in_sig)],
        'sources': [list(p) for p in _ports(out_sig)],
        'itemsizes_in': in_sig.itemsizes() if list(in_sig) else [],
        'itemsizes_out': out_sig.itemsizes() if list(out_sig) else [],
        'block_type': _BLOCK_TYPE_NAMES.get(instance._block_type, 'general'),
        'decim': instance._decim,
        'interp': instance._interp,
        # When the block leaves forecast() to its base class, the host computes it
        # from decim/interp/history itself rather than crossing into Python on
        # every scheduler iteration. Only a hand-written forecast() needs the trip.
        'overrides_forecast': type(instance).forecast not in _BASE_FORECASTS,
    }
    described.update(declaration)
    return described


def _build(source_code, params, scope):
    cls = _find_block_class(source_code)
    _init_args(cls)  # reject an unusable signature before running __init__
    block = cls(**_evaluate_params(cls, params, scope))
    return block, _describe(cls, block)


def introspect(source_code, params=None, scope=None):
    """
    Derive a block's interface from its source. `params` (id -> expression text)
    and `scope` (the flowgraph's variables) are optional: the editor introspects
    with defaults, the runner with the flowgraph's actual values, and a block
    whose ports depend on a parameter therefore reports the right ones at run
    time even when the editor's cached view is stale.
    """
    return _as_js_object(_build(source_code, params, scope)[1])


def _as_js_object(value):
    """A plain JS object, not the Map that to_js() gives a dict by default."""
    return value if js is None else to_js(value, dict_converter=js.Object.fromEntries)


def _as_dict(value):
    """Accept either a Python dict or a JS object coming across the boundary."""
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    to_py = getattr(value, 'to_py', None)
    return to_py() if to_py else dict(value)


def _evaluate_params(cls, params, scope):
    """
    Turn the flowgraph's parameter *expressions* into values, the way the
    generated Python would: each is evaluated with the flowgraph's variables in
    scope, so `samp_rate/2` or `[1, 2, 3]` mean what they mean in GRC. A
    parameter the block does not declare is ignored; one the flowgraph does not
    give keeps the __init__ default.
    """
    params = _as_dict(params)
    if not params:
        return {}
    accepted = set(inspect.getfullargspec(cls.__init__).args[1:])
    namespace = {'numpy': numpy, 'np': numpy}
    namespace.update(_as_dict(scope))
    kwargs = {}
    for key, expression in params.items():
        if key not in accepted:
            continue
        text = str(expression).strip()
        if not text:
            continue
        try:
            kwargs[key] = eval(text, namespace)
        except Exception as error:
            raise ValueError("parameter {0!r}: cannot evaluate {1!r}: {2}".format(
                key, text, error))
    return kwargs


# ---- runtime -------------------------------------------------------------

class _Port(object):
    """
    One stream port's staging buffer. The runner's circular buffers live in a
    different WebAssembly memory, so each work() call copies bytes in and out
    rather than handing Python a view of them (upstream's pointer_to_ndarray).
    The buffer is kept between calls and only ever grows.
    """

    __slots__ = ('dtype', 'vlen', 'itemsize', 'buffer')

    def __init__(self, dtype, vlen):
        self.dtype = numpy.dtype(dtype).base
        self.vlen = vlen
        self.itemsize = self.dtype.itemsize * vlen
        self.buffer = numpy.zeros(0, dtype=numpy.uint8)

    def reserve(self, nitems):
        needed = nitems * self.itemsize
        if self.buffer.size < needed:
            self.buffer = numpy.zeros(max(needed, self.buffer.size * 2), dtype=numpy.uint8)

    def raw(self, nitems):
        return self.buffer[:nitems * self.itemsize]

    def view(self, nitems):
        array = self.raw(nitems).view(self.dtype)
        return array.reshape(nitems, self.vlen) if self.vlen > 1 else array


class _Instance(object):
    __slots__ = ('block', 'inputs', 'outputs', 'description')

    def __init__(self, block, description):
        self.block = block
        self.description = description
        self.inputs = [_Port(t, vlen) for t, vlen in
                       _dtypes(block.in_sig(), description['sinks'])]
        self.outputs = [_Port(t, vlen) for t, vlen in
                        _dtypes(block.out_sig(), description['sources'])]


def _dtypes(signature, ports):
    types = signature.port_types(len(ports))
    return [(types[i], ports[i][2]) for i in range(len(ports))]


_instances = {}


def create(name, source_code, params=None, scope=None):
    """Instantiate one block and keep it under `name`. Returns its description."""
    block, description = _build(source_code, params, scope)
    _instances[name] = _Instance(block, description)
    return _as_js_object(description)


def destroy(name):
    _instances.pop(name, None)


def start(name):
    return bool(_instances[name].block.start())


def stop(name):
    return bool(_instances[name].block.stop())


def set_param(name, key, value):
    """
    Apply a live parameter change (a QT GUI Range driving a Python Block's
    parameter). Upstream this is a generated `self.blk.attr = value` callback.
    """
    setattr(_instances[name].block, key, value)


def forecast(name, noutput_items, ninputs):
    return to_js(list(_instances[name].block.handle_forecast(noutput_items, ninputs)))


def work(name, noutput_items, heap, input_pointers, input_available,
         output_pointers, nitems_read, nitems_written):
    """
    Run one scheduler call. `heap` is a Uint8Array over the *runner's* memory, so
    the copies happen here rather than in JS. Returns
    [result, consume_each, consumed..., produced...] for the caller to hand back
    through the control block; consume_each is -1 when the block did not ask.
    """
    entry = _instances[name]
    block = entry.block
    gateway = block.gateway

    input_available = list(input_available)
    if block._block_type != GW_BLOCK_GENERAL:
        # Upstream derives the input length rather than trusting ninput_items;
        # forecast() guarantees at least this many, so the min() is only a guard
        # against ever reading past what the host actually offered.
        wanted = block.fixed_rate_noutput_to_ninput(noutput_items)
        lengths = [min(wanted, available) for available in input_available]
    else:
        lengths = input_available

    inputs = []
    for i, port in enumerate(entry.inputs):
        nitems = lengths[i]
        port.reserve(nitems)
        nbytes = nitems * port.itemsize
        if nbytes:
            heap.subarray(input_pointers[i], input_pointers[i] + nbytes) \
                .assign_to(port.raw(nitems))
        inputs.append(port.view(nitems))

    outputs = []
    for port in entry.outputs:
        port.reserve(noutput_items)
        outputs.append(port.view(noutput_items))

    gateway.begin_call(list(nitems_read), list(nitems_written), ())
    result = block.handle_general_work(noutput_items, lengths, inputs, outputs)
    result = int(result) if result is not None else 0

    for i, port in enumerate(entry.outputs):
        if result == WORK_CALLED_PRODUCE:
            nitems = gateway.produced.get(i, 0)
        else:
            nitems = max(0, min(result, noutput_items))
        nbytes = nitems * port.itemsize
        if nbytes:
            heap.subarray(output_pointers[i], output_pointers[i] + nbytes) \
                .assign(port.raw(nitems))

    consume_each = -1 if gateway.consume_each_n is None else gateway.consume_each_n
    return to_js([result, consume_each]
                 + [gateway.consumed.get(i, 0) for i in range(len(entry.inputs))]
                 + [gateway.produced.get(i, 0) for i in range(len(entry.outputs))])
