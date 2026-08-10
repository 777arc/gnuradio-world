# A stream tag, standing in for gr::tag_t as the pybind11 bindings expose it.
#
# Upstream a Python block receives real `gr.tag_t` objects whose `key`/`value`
# are PMTs; here they are already-converted Python objects, because the host
# serializes the tag stream across the WASM boundary rather than handing over
# PMT pointers Pyodide could not dereference. `gnuradio.gr.tag_utils.PythonTag`
# has the same four fields, so code written against either reads the same.


class Tag(object):
    __slots__ = ("offset", "key", "value", "srcid")

    def __init__(self, offset=0, key=None, value=None, srcid=None):
        self.offset = offset
        self.key = key
        self.value = value
        self.srcid = srcid

    def __repr__(self):
        return "Tag(offset=%r, key=%r, value=%r, srcid=%r)" % (
            self.offset, self.key, self.value, self.srcid)


# The name upstream's tag_utils exports, for source compatibility.
PythonTag = Tag


def tag_to_python(tag):
    return tag


def python_to_tag(values):
    if isinstance(values, Tag):
        return values
    if isinstance(values, dict):
        return Tag(values.get("offset", 0), values.get("key"),
                   values.get("value"), values.get("srcid"))
    offset, key, value = values[0], values[1], values[2]
    return Tag(offset, key, value, values[3] if len(values) > 3 else None)
