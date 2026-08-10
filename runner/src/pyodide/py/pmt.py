# The `pmt` module a Python Block sees in the browser runner.
#
# Upstream, a PMT is an opaque C++ `pmt::pmt_t` and this module is a pybind11
# wrapper around it. There is no C++ to wrap here -- the runner's GNU Radio lives
# in a separate WebAssembly instance -- so a PMT *is* an ordinary Python object:
#
#   symbol            Symbol (a str subclass, so it prints and hashes as its name)
#   string            str
#   bool/number       bool / int / float / complex
#   pair              Pair(car, cdr)
#   dict              dict
#   uniform vector    numpy array of the matching dtype
#   NIL               PMT_NIL
#
# That makes `pmt.to_python()` close to the identity, which is the point: the host
# converts messages and tags at the boundary once, and everything the block does
# with them afterwards is plain Python. Code written against the real module keeps
# working because the function names and their meanings are unchanged.
#
# Anything not implemented raises with a message saying so rather than looking
# like a typo. Message ports and tags themselves are not wired up yet; see
# docs/embedded-python.md.

import numpy


class Symbol(str):
    """An interned PMT symbol. A str subclass, so `pmt.symbol_to_string` is free."""

    __slots__ = ()

    def __repr__(self):
        return str.__str__(self)


class Pair(object):
    __slots__ = ("car", "cdr")

    def __init__(self, car, cdr):
        self.car = car
        self.cdr = cdr

    def __eq__(self, other):
        return isinstance(other, Pair) and self.car == other.car and self.cdr == other.cdr

    def __hash__(self):
        return hash((self.car, self.cdr))

    def __repr__(self):
        return "(%r . %r)" % (self.car, self.cdr)


class _Nil(object):
    __slots__ = ()

    def __repr__(self):
        return "#nil"

    def __bool__(self):
        return False


PMT_NIL = _Nil()
PMT_T = True
PMT_F = False
PMT_EOF = _Nil()

_VECTOR_DTYPES = {
    "u8": numpy.uint8, "s8": numpy.int8,
    "u16": numpy.uint16, "s16": numpy.int16,
    "u32": numpy.uint32, "s32": numpy.int32,
    "u64": numpy.uint64, "s64": numpy.int64,
    "f32": numpy.float32, "f64": numpy.float64,
    "c32": numpy.complex64, "c64": numpy.complex128,
}


# -- symbols and strings ----------------------------------------------------

def intern(s):
    return Symbol(s)


string_to_symbol = intern


def symbol_to_string(s):
    return str(s)


def is_symbol(x):
    return isinstance(x, Symbol)


def from_bool(x):
    return bool(x)


def to_bool(x):
    return bool(x)


def is_bool(x):
    return isinstance(x, bool)


def from_long(x):
    return int(x)


def to_long(x):
    return int(x)


def from_uint64(x):
    return int(x)


def to_uint64(x):
    return int(x)


def from_double(x):
    return float(x)


def to_double(x):
    return float(x)


def from_complex(*args):
    return complex(*args) if len(args) != 2 else complex(args[0], args[1])


def to_complex(x):
    return complex(x)


def is_integer(x):
    return isinstance(x, int) and not isinstance(x, bool)


def is_real(x):
    return isinstance(x, float)


def is_number(x):
    return isinstance(x, (int, float, complex)) and not isinstance(x, bool)


def is_null(x):
    return x is PMT_NIL or isinstance(x, _Nil)


# -- pairs ------------------------------------------------------------------

def cons(car_, cdr_):
    return Pair(car_, cdr_)


def car(p):
    if isinstance(p, Pair):
        return p.car
    raise TypeError("pmt.car: not a pair: %r" % (p,))


def cdr(p):
    if isinstance(p, Pair):
        return p.cdr
    raise TypeError("pmt.cdr: not a pair: %r" % (p,))


def is_pair(x):
    return isinstance(x, Pair)


# -- dicts ------------------------------------------------------------------

def make_dict():
    return {}


def is_dict(x):
    return isinstance(x, dict)


def dict_add(d, key, value):
    # PMT dicts are persistent: dict_add returns a new dict.
    out = dict(d)
    out[key] = value
    return out


def dict_delete(d, key):
    out = dict(d)
    out.pop(key, None)
    return out


def dict_has_key(d, key):
    return key in d


def dict_ref(d, key, default=PMT_NIL):
    return d.get(key, default)


def dict_keys(d):
    return list(d.keys())


def dict_values(d):
    return list(d.values())


def dict_items(d):
    return [Pair(k, v) for k, v in d.items()]


# -- uniform vectors --------------------------------------------------------

def _init_vector(name):
    dtype = _VECTOR_DTYPES[name]

    def init(nitems, values=None):
        if values is None:
            return numpy.zeros(nitems, dtype=dtype)
        return numpy.asarray(values, dtype=dtype)[:nitems].copy()

    return init


def _vector_elements(name):
    dtype = _VECTOR_DTYPES[name]

    def elements(vector):
        return numpy.asarray(vector, dtype=dtype)

    return elements


for _name in _VECTOR_DTYPES:
    globals()["init_%svector" % _name] = _init_vector(_name)
    globals()["%svector_elements" % _name] = _vector_elements(_name)
    globals()["make_%svector" % _name] = _init_vector(_name)
del _name


def is_uniform_vector(x):
    return isinstance(x, numpy.ndarray)


def uniform_vector_elements(vector, item=0):
    return numpy.asarray(vector)[item:]


def length(x):
    return len(x)


def is_vector(x):
    return isinstance(x, (list, tuple))


def make_vector(nitems, fill=PMT_NIL):
    return [fill] * nitems


def vector_ref(v, k):
    return v[k]


def vector_set(v, k, obj):
    v[k] = obj


def equal(a, b):
    if isinstance(a, numpy.ndarray) or isinstance(b, numpy.ndarray):
        return numpy.array_equal(a, b)
    return a == b


def eq(a, b):
    return a is b or a == b


# -- conversion -------------------------------------------------------------

def to_python(x):
    """
    A PMT is already a Python object here, so this only normalizes the two
    representations a caller would not expect to see: NIL becomes None and a
    symbol becomes a plain str, matching what the real pmt.to_python returns.
    """
    if isinstance(x, _Nil):
        return None
    if isinstance(x, Symbol):
        return str(x)
    if isinstance(x, Pair):
        return (to_python(x.car), to_python(x.cdr))
    if isinstance(x, dict):
        return {to_python(k): to_python(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [to_python(v) for v in x]
    return x


def to_pmt(x):
    if x is None:
        return PMT_NIL
    if isinstance(x, tuple) and len(x) == 2:
        return Pair(to_pmt(x[0]), to_pmt(x[1]))
    if isinstance(x, dict):
        return {to_pmt(k): to_pmt(v) for k, v in x.items()}
    return x


from_python = to_pmt


def write_string(x):
    return repr(to_python(x))


def serialize_str(x):
    raise NotImplementedError(
        "pmt.serialize_str() has no meaning in the browser runner: a PMT here is a "
        "plain Python object, not a C++ pmt_t. Use repr() or pmt.write_string().")


def deserialize_str(x):
    raise NotImplementedError("pmt.deserialize_str() is not available; see serialize_str().")


_UNAVAILABLE = (
    "pmt.{0} is not implemented in the browser runner's pmt shim. A PMT here is an "
    "ordinary Python object -- symbols are str, dicts are dict, uniform vectors are "
    "numpy arrays -- so most of what {0} would do can be done directly. If a Python "
    "Block genuinely needs it, add it to runner/src/pyodide/py/pmt.py."
)


def __getattr__(name):
    raise AttributeError(_UNAVAILABLE.format(name))
