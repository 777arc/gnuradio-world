#!/usr/bin/env python3
"""
Host test for the Embedded Python Block's Python side, runnable without a browser:

    python3 runner/test/test_grworld.py        # needs numpy

runner/src/pyodide/py/ is the shim a Python Block's own source runs against
(gnuradio.gr's four base classes, py_io_signature, pmt) plus grworld, which
introspects that source and drives its work() calls. All of it is plain Python
bar two Pyodide conversion helpers, which grworld degrades to identity when `js`
is not importable -- so everything intricate about the block contract is testable
here, in a second, instead of only inside a browser.

The cases follow gnuradio/gr-blocks/python/blocks/qa_block_gateway.py and the
self-test at the bottom of gnuradio/grc/core/utils/epy_block_io.py, which between
them are upstream's specification of what a Python block may do.
"""

import json
import os
import sys
import traceback

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'pyodide', 'py'))

import grworld  # noqa: E402

FAILURES = []


def check(condition, what):
    if condition:
        print('  ok   %s' % what)
    else:
        print('  FAIL %s' % what)
        FAILURES.append(what)


def check_equal(got, want, what):
    check(got == want, '%s (got %r, want %r)' % (what, got, want) if got != want else what)


def check_raises(fn, fragment, what):
    try:
        fn()
    except Exception as error:  # noqa: BLE001 -- any failure mode counts
        check(fragment in str(error), '%s -- %r contains %r' % (what, str(error), fragment))
    else:
        check(False, '%s -- nothing raised' % what)


class Heap(object):
    """
    Stands in for the Uint8Array over the runner's WebAssembly memory that the
    worker hands to grworld.work(). Only .subarray(a, b) with .assign_to()/
    .assign() is used, which is the whole of the JS buffer surface grworld needs.
    """

    def __init__(self, nbytes):
        self.bytes = bytearray(nbytes)

    def subarray(self, start, end):
        return _HeapView(self.bytes, start, end)

    def write(self, offset, array):
        raw = np.asarray(array).tobytes()
        self.bytes[offset:offset + len(raw)] = raw

    def read(self, offset, count, dtype):
        raw = bytes(self.bytes[offset:offset + count * np.dtype(dtype).itemsize])
        return np.frombuffer(raw, dtype=dtype)


class _HeapView(object):
    def __init__(self, buffer, start, end):
        self.buffer, self.start, self.end = buffer, start, end

    def assign_to(self, target):
        source = bytes(self.buffer[self.start:self.end])
        assert len(source) == target.nbytes, 'assign_to length mismatch'
        target[:] = np.frombuffer(source, dtype=np.uint8)

    def assign(self, source):
        raw = np.asarray(source).tobytes()
        assert len(raw) == self.end - self.start, 'assign length mismatch'
        self.buffer[self.start:self.end] = raw


SYNC_SOURCE = '''
import numpy as np
from gnuradio import gr

class blk(gr.sync_block):
    """Multiply by a constant"""

    def __init__(self, factor=2.0):
        gr.sync_block.__init__(self, name='Scale', in_sig=[np.complex64],
                               out_sig=[np.complex64])
        self.factor = factor

    def work(self, input_items, output_items):
        output_items[0][:] = input_items[0] * self.factor
        return len(output_items[0])
'''


def test_introspection():
    print('introspection')
    io = grworld.introspect(SYNC_SOURCE)
    check_equal(io['cls'], 'blk', 'class name')
    check_equal(io['label'], 'Scale', "label is the block's name(), not the class")
    check_equal(io['doc'], 'Multiply by a constant', 'docstring')
    check_equal(io['params'], [['factor', '2.0']], 'params carry repr() defaults')
    check_equal(io['callbacks'], ['factor'], 'a plain instance attribute is a callback')
    check_equal(io['sinks'], [['0', 'complex', 1]], 'input port')
    check_equal(io['sources'], [['0', 'complex', 1]], 'output port')
    check_equal(io['itemsizes_in'], [8], 'complex64 is 8 bytes')
    check_equal(io['block_type'], 'sync', 'block type')
    check_equal(io['history'], 1, 'default history')

    # Upstream's TYPE_MAP has no float64 entry, and neither do we: a port type it
    # cannot name must be an error rather than a silently mistyped port.
    check_raises(lambda: grworld.introspect(SYNC_SOURCE.replace('complex64', 'float64')),
                 "Can't map", 'float64 in an io signature is rejected')
    check_raises(lambda: grworld.introspect('x = 1'),
                 'No Python block class found', 'source with no block class')
    check_raises(lambda: grworld.introspect(SYNC_SOURCE.replace('factor=2.0', 'factor')),
                 'default values', '__init__ argument without a default')

    # Upstream picks the first gateway_block subclass in the exec'd namespace,
    # which is the imported base class itself when the source imports it by name.
    imported = SYNC_SOURCE.replace('from gnuradio import gr',
                                   'from gnuradio import gr\nfrom gnuradio.gr import sync_block')
    check_equal(grworld.introspect(imported)['cls'], 'blk',
                'an imported base class is not mistaken for the block')


def test_callbacks_and_ports():
    print('callbacks, message ports and vlen')
    source = '''
import numpy as np
import pmt
from gnuradio import gr

class blk(gr.sync_block):
    def __init__(self, param1=None, param2=None, param3=None):
        gr.sync_block.__init__(self, name='test', in_sig=(np.float32,),
                               out_sig=(np.float32, (np.float32, 2)))
        self.param1 = param1
        self._param2 = param2
        self._param3 = param3
        self.message_port_register_in(pmt.intern('msg_in'))
        self.message_port_register_out(pmt.intern('msg_out'))

    @property
    def param2(self):
        return self._param2

    @property
    def param3(self):
        return self._param3

    @param3.setter
    def param3(self, value):
        self._param3 = value
'''
    io = grworld.introspect(source)
    # epy_block_io's own self-test asserts exactly this: a plain attribute and a
    # property *with a setter* are callbacks; a read-only property is not.
    check_equal(io['callbacks'], ['param1', 'param3'], 'read-only property is not a callback')
    check_equal(io['sources'], [['0', 'float', 1], ['1', 'float', 2]],
                'a sub-array dtype becomes vlen')
    # itemsizes_* is what the host feeds io_signature::makev, so a vlen-2 float
    # port is 8 bytes per item, not 4 -- upstream's gr_io_signature() agrees.
    check_equal(io['itemsizes_out'], [4, 8], 'itemsize includes vlen')
    check_equal(io['msg_ports_in'], ['msg_in'], 'registered input message port')
    check_equal(io['msg_ports_out'], ['msg_out'], 'registered output message port')


def test_param_evaluation():
    print('parameter evaluation')
    source = SYNC_SOURCE.replace('factor=2.0', 'factor=2.0, taps=None')
    # Expressions are evaluated with the flowgraph's variables in scope, exactly
    # as the generated Python would evaluate them.
    io = grworld.create('scope_block', source,
                        {'factor': 'samp_rate / 8', 'taps': '[1, 2, 3]'},
                        {'samp_rate': 32000})
    check_equal(io['cls'], 'blk', 'created with evaluated parameters')
    check_equal(grworld._instances['scope_block'].block.factor, 4000.0,
                'samp_rate / 8 evaluated against the flowgraph scope')
    check_raises(lambda: grworld.create('bad', source, {'factor': 'nope('}, {}),
                 'cannot evaluate', 'a broken parameter expression names itself')
    grworld.destroy('scope_block')


def run_work(name, noutput_items, inputs, dtypes_out, available=None, heap_size=1 << 20):
    """
    Drive one work() call the way the worker does, with the input arrays laid out
    in a fake heap. Returns (result_list, heap, output_pointers).
    """
    heap = Heap(heap_size)
    in_pointers, offset = [], 0
    for array in inputs:
        heap.write(offset, array)
        in_pointers.append(offset)
        offset += max(array.nbytes, 1)
    out_pointers = []
    for dtype in dtypes_out:
        out_pointers.append(offset)
        offset += noutput_items * np.dtype(dtype).itemsize
    result = grworld.work(
        name, noutput_items, heap, in_pointers,
        available if available is not None else [len(a) for a in inputs],
        out_pointers, [0] * len(inputs), [0] * len(dtypes_out))
    return result, heap, out_pointers


def test_sync_work():
    print('sync block work()')
    grworld.create('scale', SYNC_SOURCE, {'factor': '3'}, {})
    samples = np.arange(16, dtype=np.complex64) + 1j
    result, heap, out = run_work('scale', 16, [samples], [np.complex64])
    check_equal(result[0], 16, 'work() returned the item count')
    check_equal(result[1], 16, 'sync_block consumed each')
    check(np.allclose(heap.read(out[0], 16, np.complex64), samples * 3),
          'output samples are the input times the factor')
    grworld.destroy('scale')


def test_history():
    print('history')
    source = '''
import numpy as np
from gnuradio import gr

class blk(gr.sync_block):
    def __init__(self, taps=3):
        gr.sync_block.__init__(self, name='hist', in_sig=[np.float32], out_sig=[np.float32])
        self.set_history(taps)

    def work(self, input_items, output_items):
        n = len(output_items[0])
        # A history of `taps` means work() sees n + taps - 1 input items.
        assert len(input_items[0]) == n + self.history() - 1, len(input_items[0])
        output_items[0][:] = input_items[0][: n] + input_items[0][self.history() - 1:]
        return n
'''
    io = grworld.create('hist', source, {'taps': '4'}, {})
    check_equal(io['history'], 4, 'set_history() from __init__ is reported to the host')
    samples = np.arange(32, dtype=np.float32)
    result, heap, out = run_work('hist', 16, [samples], [np.float32])
    check_equal(result[0], 16, 'work() ran with the derived input length')
    check(np.allclose(heap.read(out[0], 16, np.float32),
                      samples[:16] + samples[3:19]), 'history window is the older samples')
    grworld.destroy('hist')


def test_decim_and_interp():
    print('decim and interp')
    decim = '''
import numpy as np
from gnuradio import gr

class blk(gr.decim_block):
    def __init__(self):
        gr.decim_block.__init__(self, name='decim2x', in_sig=[np.float32],
                                out_sig=[np.float32], decim=2)

    def work(self, input_items, output_items):
        output_items[0][:] = input_items[0][::2][: len(output_items[0])]
        return len(output_items[0])
'''
    io = grworld.create('decim', decim, {}, {})
    check_equal(io['block_type'], 'decim', 'decim block type')
    check_equal(io['decim'], 2, 'decimation reported')
    check_equal(io['output_multiple'], 1, 'decim_block sets an output multiple')
    check_equal(list(grworld.forecast('decim', 8, 1)), [16], 'forecast asks for decim*noutput')
    samples = np.arange(32, dtype=np.float32)
    result, heap, out = run_work('decim', 8, [samples], [np.float32])
    check_equal(result[1], 16, 'decim_block consumed decim * produced')
    check(np.allclose(heap.read(out[0], 8, np.float32), samples[:16:2]), 'decimated output')
    grworld.destroy('decim')

    interp = decim.replace('decim_block', 'interp_block').replace('decim=2', 'interp=2') \
        .replace("name='decim2x'", "name='interp2x'").replace('[::2]', '.repeat(2)')
    grworld.create('interp', interp, {}, {})
    result, heap, out = run_work('interp', 16, [np.arange(16, dtype=np.float32)],
                                 [np.float32])
    check_equal(result[1], 8, 'interp_block consumed produced / interp')
    grworld.destroy('interp')


def test_general_work():
    print('basic_block general_work()')
    source = '''
import numpy as np
from gnuradio import gr

class blk(gr.basic_block):
    def __init__(self):
        gr.basic_block.__init__(self, name='non_sync', in_sig=[np.float32],
                                out_sig=[np.float32])

    def forecast(self, noutput_items, ninputs):
        return [noutput_items] * ninputs

    def general_work(self, input_items, output_items):
        # qa_block_gateway's non_sync_block: consume/produce by hand and report
        # WORK_CALLED_PRODUCE rather than an item count.
        n = min(len(input_items[0]), len(output_items[0]))
        output_items[0][:n] = input_items[0][:n]
        self.consume(0, n)
        self.produce(0, n // 2)
        return gr.WORK_CALLED_PRODUCE
'''
    grworld.create('general', source, {}, {})
    samples = np.arange(20, dtype=np.float32)
    result, heap, out = run_work('general', 20, [samples], [np.float32])
    check_equal(result[0], -2, 'WORK_CALLED_PRODUCE is passed back to the host')
    check_equal(result[1], -1, 'general block did not call consume_each')
    check_equal(result[2], 20, 'per-port consume() recorded')
    check_equal(result[3], 10, 'per-port produce() recorded')
    # Only the produced items are copied back; the rest of the output buffer is
    # left alone, exactly as a C++ block leaves it.
    check(np.allclose(heap.read(out[0], 10, np.float32), samples[:10]),
          'produced items were written out')
    grworld.destroy('general')


def test_set_param():
    print('live parameter updates')
    grworld.create('live', SYNC_SOURCE, {'factor': '1'}, {})
    grworld.set_param('live', 'factor', 5.0)
    samples = np.ones(4, dtype=np.complex64)
    _, heap, out = run_work('live', 4, [samples], [np.complex64])
    check(np.allclose(heap.read(out[0], 4, np.complex64), samples * 5),
          'set_param() reached the running block')
    grworld.destroy('live')


def test_start_stop_and_errors():
    print('start/stop and error reporting')
    source = SYNC_SOURCE + '''
    def start(self):
        print('started')
        return True

    def stop(self):
        return False
'''
    grworld.create('lifecycle', source, {}, {})
    check_equal(grworld.start('lifecycle'), True, 'start() forwarded')
    check_equal(grworld.stop('lifecycle'), False, 'stop() forwarded')
    grworld.destroy('lifecycle')

    throwing = SYNC_SOURCE.replace('return len(output_items[0])',
                                   "raise ValueError('boom')")
    grworld.create('throwing', throwing, {}, {})
    try:
        run_work('throwing', 4, [np.zeros(4, dtype=np.complex64)], [np.complex64])
    except Exception as error:  # noqa: BLE001
        text = ''.join(traceback.format_exception(type(error), error, error.__traceback__))
        check('boom' in text and 'work' in text,
              'a raise in work() yields a traceback naming the block')
    else:
        check(False, 'a raise in work() propagated to the host')
    grworld.destroy('throwing')


def test_block_yaml_defaults_agree():
    """
    blocks/grc/epy_block.block.yml ships two defaults that have to describe the
    same block: the source code, and the `_io_cache` the editor draws ports from
    before any Python runtime is fetched. Nothing at runtime would notice them
    drifting apart -- a freshly placed Python Block would simply show the wrong
    ports -- so check it here.
    """
    print('block yaml defaults')
    try:
        import yaml
    except ImportError:
        print('  skip (no pyyaml)')
        return
    path = os.path.join(os.path.dirname(__file__), '..', '..', 'blocks', 'grc',
                        'epy_block.block.yml')
    parameters = {p['id']: p for p in yaml.safe_load(open(path))['parameters']}
    derived = grworld.introspect(parameters['_source_code']['default'])
    cached = json.loads(parameters['_io_cache']['default'])
    check_equal(cached, derived, '_io_cache default matches the default source')

    # And the default source is upstream's template, with one deliberate change:
    # `example_param=1` rather than `=1.0`. Pinning it as "upstream plus exactly
    # that one edit" still catches an upstream change to the template, which a
    # looser check would let through silently.
    native_path = os.path.join(os.path.dirname(__file__), '..', '..', 'gnuradio', 'grc',
                               'core', 'blocks', 'embedded_python.py')
    if os.path.exists(native_path):
        native = open(native_path).read()
        start = native.index("DEFAULT_CODE = '''\\") + len("DEFAULT_CODE = '''\\\n")
        upstream = native[start:native.index("'''\n\nDOC")]
        check_equal(parameters['_source_code']['default'],
                    upstream.replace('example_param=1.0)', 'example_param=1)'),
                    "default code is upstream's DEFAULT_CODE bar the example_param default")


def main():
    for test in (test_introspection, test_callbacks_and_ports, test_param_evaluation,
                 test_sync_work, test_history, test_decim_and_interp, test_general_work,
                 test_set_param, test_start_stop_and_errors,
                 test_block_yaml_defaults_agree):
        test()
    print()
    if FAILURES:
        print('GRWORLD_FAIL: %d check(s) failed' % len(FAILURES))
        return 1
    print('GRWORLD_PASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
