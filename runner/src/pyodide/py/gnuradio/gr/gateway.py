# Browser port of gnuradio-runtime/python/gnuradio/gr/gateway.py.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Upstream, a Python block is a plain object owning a C++ `block_gateway`
# (a pybind11 trampoline) and forwarding every unknown attribute to it, so
# `self.consume_each(...)`, `self.nitems_read(0)`, `self.set_history(n)` and the
# rest resolve into the C++ block. There is no pybind11 here and no way to reach
# the runner's C++ objects from inside Pyodide's separate WASM instance, so the
# same `self.gateway` slot holds `_Gateway` below: a pure-Python stand-in that
# reads what the host pre-supplied for the current work() call and *records* what
# the block asks to do, for the host to apply once work() returns.
#
# What is deliberately identical to upstream is everything a block's own source
# touches: the four base classes, `py_io_signature`, the work()/general_work()
# contract, `consume`/`consume_each`/`produce`, `history()`, `nitems_read/written`
# and the message-port calls. A block written for desktop GNU Radio runs here
# unmodified, which is the whole point.
#
# What differs, and why:
#   * intents are batched, not immediate. The GR thread that asked for this
#     work() call is blocked in a futex while Python runs and so cannot service a
#     call back into C++; see docs/embedded-python.md.
#   * input/output arrays are copies of the host's circular buffers, not
#     zero-copy views of them (upstream's `pointer_to_ndarray`). Two WASM
#     memories cannot alias.

import numpy

# Block types, matching gr::block_gateway's enum. As upstream, only
# GW_BLOCK_GENERAL is behaviourally distinct; interp_block passes GW_BLOCK_DECIM.
GW_BLOCK_GENERAL = 0
GW_BLOCK_SYNC = 1
GW_BLOCK_DECIM = 2
GW_BLOCK_INTERP = 3

WORK_CALLED_PRODUCE = -2
WORK_DONE = -1

# Tag propagation policies (gr::block::tag_propagation_policy_t).
TPP_DONT = 0
TPP_ALL_TO_ALL = 1
TPP_ONE_TO_ONE = 2
TPP_CUSTOM = 3

sizeof_char = 1
sizeof_short = 2
sizeof_int = 4
sizeof_float = 4
sizeof_double = 8
sizeof_gr_complex = 8


class py_io_signature(object):
    """
    Describes the type/number of ports for block input or output.
    """

    # Minimum and maximum number of ports, and a list of numpy types.
    def __init__(self, min_ports, max_ports, type_list):
        self.__min_ports = min_ports
        self.__max_ports = max_ports
        self.__types = tuple(numpy.dtype(t) for t in type_list)

    def gr_io_signature(self):
        """
        Upstream returns a C++ io_signature; the browser runner builds its own
        from `itemsizes()` before the Python object exists, so this is only kept
        for source compatibility with a block that calls it.
        """
        return (self.__min_ports, self.__max_ports, list(self.itemsizes()))

    def itemsizes(self):
        return [t.itemsize for t in self.__types] or [0]

    def min_ports(self):
        return self.__min_ports

    def max_ports(self):
        return self.__max_ports

    def port_types(self, nports):
        """
        Return data types for the first nports ports. If there are more ports
        than types, the last type is repeated.
        """
        ntypes = len(self.__types)
        if ntypes == 0:
            return ()
        if nports <= ntypes:
            return self.__types[:nports]
        return self.__types + (self.__types[-1],) * (nports - ntypes)

    def __iter__(self):
        return iter(self.port_types(self.__max_ports))


class _Logger(object):
    """
    `self.logger.info(...)` as upstream's `block_gateway::_get_logger` exposes it.
    Everything lands on stdout, which the runner forwards to the editor's console
    pane the same way a C++ block's printf does.
    """

    def __init__(self, name):
        self._name = name

    def _log(self, level, message, *args):
        text = str(message) % args if args else str(message)
        print("%s: %s: %s" % (level, self._name, text))

    def debug(self, message, *args):
        pass

    def trace(self, message, *args):
        pass

    def info(self, message, *args):
        self._log("info", message, *args)

    def warn(self, message, *args):
        self._log("warn", message, *args)

    warning = warn

    def error(self, message, *args):
        self._log("error", message, *args)

    def crit(self, message, *args):
        self._log("crit", message, *args)

    critical = crit


class _Gateway(object):
    """
    Stands in for the C++ block, on both sides of the block's life:

    * while GRC/the editor introspects the source, and while the runner is still
      deciding what io_signature to give the C++ block, nothing is attached --
      reads answer with defaults and intents go nowhere. This is the state in
      which `__init__` runs, which is exactly why `set_history()` and
      `set_output_multiple()` called from there are *recorded*: the host reads
      them back and applies them to the real block before its buffers exist.
    * once running, `begin_call()` installs the values the host pre-supplied for
      this one work() call, and every intent is appended for `end_call()` to hand
      back.
    """

    def __init__(self, name, in_sig, out_sig):
        self._name = name
        self._alias = name
        self._in_sig = in_sig
        self._out_sig = out_sig
        self.logger = _Logger(name)

        # Declared from __init__, read back by the host before construction.
        self._history = 1
        self._output_multiple = 1
        self._output_multiple_set = False
        self._relative_rate = 1.0
        self._tag_propagation_policy = TPP_ALL_TO_ALL
        self._min_output_buffer = 0
        self._max_noutput_items = 0
        self._msg_ports_in = []
        self._msg_ports_out = []
        self._msg_handlers = {}

        # Per-call state, replaced by begin_call().
        self._nitems_read = ()
        self._nitems_written = ()
        self._tags = ()
        self.reset_intents()

    # -- host side ----------------------------------------------------------

    def reset_intents(self):
        self.consumed = {}
        self.produced = {}
        self.consume_each_n = None
        self.tags_out = []
        self.messages_out = []

    def begin_call(self, nitems_read, nitems_written, tags):
        self._nitems_read = nitems_read
        self._nitems_written = nitems_written
        self._tags = tags
        self.reset_intents()

    def declaration(self):
        """Everything the host must know before it can build the C++ block."""
        return {
            "history": self._history,
            "output_multiple": self._output_multiple if self._output_multiple_set else 0,
            "relative_rate": self._relative_rate,
            "tag_propagation_policy": self._tag_propagation_policy,
            "min_output_buffer": self._min_output_buffer,
            "max_noutput_items": self._max_noutput_items,
            "msg_ports_in": list(self._msg_ports_in),
            "msg_ports_out": list(self._msg_ports_out),
        }

    # -- gr::basic_block ----------------------------------------------------

    def name(self):
        return self._name

    def symbol_name(self):
        return self._name

    def alias(self):
        return self._alias

    def set_alias(self, alias):
        self._alias = alias

    def to_basic_block(self):
        return self

    def in_sig(self):
        return self._in_sig

    def out_sig(self):
        return self._out_sig

    # -- gr::block configuration, all recorded for the host -----------------

    def history(self):
        return self._history

    def set_history(self, history):
        self._history = int(history)

    def declare_sample_delay(self, delay):
        self._history = int(delay) + 1

    def output_multiple(self):
        return self._output_multiple

    def set_output_multiple(self, multiple):
        self._output_multiple = int(multiple)
        self._output_multiple_set = True

    def relative_rate(self):
        return self._relative_rate

    def set_relative_rate(self, *args):
        # set_relative_rate(double) and set_relative_rate(interp, decim).
        if len(args) == 2:
            self._relative_rate = float(args[0]) / float(args[1])
        else:
            self._relative_rate = float(args[0])

    def set_tag_propagation_policy(self, policy):
        self._tag_propagation_policy = int(policy)

    def tag_propagation_policy(self):
        return self._tag_propagation_policy

    def set_min_output_buffer(self, *args):
        self._min_output_buffer = int(args[-1])

    def set_max_noutput_items(self, m):
        self._max_noutput_items = int(m)

    def set_thread_priority(self, priority):
        pass

    def set_processor_affinity(self, mask):
        pass

    # -- per-call reads -----------------------------------------------------

    def nitems_read(self, which_input=0):
        try:
            return self._nitems_read[which_input]
        except IndexError:
            return 0

    def nitems_written(self, which_output=0):
        try:
            return self._nitems_written[which_output]
        except IndexError:
            return 0

    # -- per-call intents ---------------------------------------------------

    def consume(self, which_input, how_many_items):
        self.consumed[which_input] = self.consumed.get(which_input, 0) + int(how_many_items)

    def consume_each(self, how_many_items):
        self.consume_each_n = int(how_many_items)

    def produce(self, which_output, how_many_items):
        self.produced[which_output] = self.produced.get(which_output, 0) + int(how_many_items)

    # -- tags ---------------------------------------------------------------

    def add_item_tag(self, which_output, *args):
        # add_item_tag(port, tag) and add_item_tag(port, offset, key, value[, srcid]).
        if len(args) == 1:
            tag = args[0]
            entry = (which_output, tag.offset, tag.key, tag.value, tag.srcid)
        else:
            srcid = args[3] if len(args) > 3 else None
            entry = (which_output, args[0], args[1], args[2], srcid)
        self.tags_out.append(entry)

    def get_tags_in_range(self, which_input, abs_start, abs_end, key=None):
        out = []
        for port, offset, tag_key, value, srcid in self._tags:
            if port != which_input or not (abs_start <= offset < abs_end):
                continue
            if key is not None and tag_key != key:
                continue
            out.append(Tag(offset, tag_key, value, srcid))
        return out

    def get_tags_in_window(self, which_input, rel_start, rel_end, key=None):
        base = self.nitems_read(which_input)
        return self.get_tags_in_range(which_input, base + rel_start, base + rel_end, key)

    # -- message ports ------------------------------------------------------

    def message_port_register_in(self, port_id):
        name = str(port_id)
        if name not in self._msg_ports_in:
            self._msg_ports_in.append(name)

    def message_port_register_out(self, port_id):
        name = str(port_id)
        if name not in self._msg_ports_out:
            self._msg_ports_out.append(name)

    def message_ports_in(self):
        return list(self._msg_ports_in)

    def message_ports_out(self):
        return list(self._msg_ports_out)

    def message_port_pub(self, port_id, msg):
        self.messages_out.append((str(port_id), msg))

    def message_port_sub(self, port_id, target):
        raise NotImplementedError(
            "message_port_sub() is not available in the browser runner; "
            "connect message ports in the flowgraph instead")

    def set_msg_handler_pybind(self, port_id, handler_name):
        self._msg_handlers[str(port_id)] = handler_name

    def has_msg_handler(self, port_id):
        return str(port_id) in self._msg_handlers

    def nmsgs(self, port_id):
        return 0


class gateway_block(object):
    def __init__(self, name, in_sig, out_sig, block_type):
        self._decim = 1
        self._interp = 1
        self._block_type = block_type

        in_sig = in_sig or ()
        out_sig = out_sig or ()

        if type(in_sig) is py_io_signature:
            self.__in_sig = in_sig
        else:
            self.__in_sig = py_io_signature(len(in_sig), len(in_sig), in_sig)

        if type(out_sig) is py_io_signature:
            self.__out_sig = out_sig
        else:
            self.__out_sig = py_io_signature(len(out_sig), len(out_sig), out_sig)

        self.gateway = _Gateway(name, self.__in_sig, self.__out_sig)
        self.msg_handlers = {}

    def __getattr__(self, name):
        """Pass-through member requests to the stand-in block object."""
        if name == "gateway" or "gateway" not in self.__dict__:
            raise AttributeError(
                "{0}: invalid state -- did you forget to call {0}.__init__ in "
                "a derived class?".format(self.__class__.__name__))
        return getattr(self.gateway, name)

    def to_basic_block(self):
        return self.gateway

    def in_sig(self):
        return self.__in_sig

    def out_sig(self):
        return self.__out_sig

    def set_msg_handler(self, which_port, handler_function):
        # Upstream can only pass a *name* across pybind11 and looks the attribute
        # up on the instance per message, so a lambda or a partial breaks there.
        # Holding the callable is strictly better and accepts the same code.
        self.gateway.set_msg_handler_pybind(which_port, getattr(handler_function, "__name__", ""))
        self.msg_handlers[str(which_port)] = handler_function

    def fixed_rate_noutput_to_ninput(self, noutput_items):
        return int((noutput_items * self._decim / self._interp) + self.gateway.history() - 1)

    def handle_forecast(self, noutput_items, ninputs):
        return self.forecast(noutput_items, ninputs)

    def forecast(self, noutput_items, ninputs):
        """
        forecast is only called from a general block
        this is the default implementation
        """
        ninput_items_required = [0] * ninputs
        for i in range(ninputs):
            ninput_items_required[i] = noutput_items + self.gateway.history() - 1
        return ninput_items_required

    def handle_general_work(self, noutput_items, ninput_items, input_items, output_items):
        """
        Same contract as upstream's, minus the PyCapsule unwrapping: the host has
        already turned its buffers into the numpy arrays passed in, sized as
        upstream sizes them (fixed-rate blocks see noutput*decim/interp+history-1
        input items, general blocks see ninput_items[i]).
        """
        if self._block_type != GW_BLOCK_GENERAL:
            r = self.work(input_items, output_items)
            self.consume_items(r)
        else:
            r = self.general_work(input_items, output_items)
        return r

    def consume_items(self, nitems):
        raise NotImplementedError("consume_items() is implemented by the subclass")

    def work(self, input_items, output_items):
        """Called when the block has data to process."""
        raise NotImplementedError("work() is not implemented")

    def general_work(self, input_items, output_items):
        """Called when the block has data to process."""
        raise NotImplementedError("general_work() is not implemented")

    def start(self):
        return True

    def stop(self):
        return True


class basic_block(gateway_block):
    """
    Args:
        name (str): block name
        in_sig (list, py_io_signature): input signature
        out_sig (list, py_io_signature): output signature
    """

    def __init__(self, name, in_sig, out_sig):
        gateway_block.__init__(self,
                               name=name,
                               in_sig=in_sig,
                               out_sig=out_sig,
                               block_type=GW_BLOCK_GENERAL)

    def consume_items(self, nitems):
        pass


class sync_block(gateway_block):
    def __init__(self, name, in_sig, out_sig):
        gateway_block.__init__(self,
                               name=name,
                               in_sig=in_sig,
                               out_sig=out_sig,
                               block_type=GW_BLOCK_SYNC)
        self._decim = 1
        self._interp = 1

    def consume_items(self, nitems):
        if nitems > 0:
            self.gateway.consume_each(nitems)


class decim_block(gateway_block):
    def __init__(self, name, in_sig, out_sig, decim):
        gateway_block.__init__(self,
                               name=name,
                               in_sig=in_sig,
                               out_sig=out_sig,
                               block_type=GW_BLOCK_DECIM)
        self._decim = decim
        self._interp = 1
        self.gateway.set_relative_rate(self._interp, self._decim)
        self.gateway.set_output_multiple(self._interp)

    def forecast(self, noutput_items, ninputs):
        return [self.fixed_rate_noutput_to_ninput(noutput_items)] * ninputs

    def consume_items(self, nitems):
        if nitems > 0:
            self.gateway.consume_each(int(nitems * self._decim))


class interp_block(gateway_block):
    def __init__(self, name, in_sig, out_sig, interp):
        gateway_block.__init__(self,
                               name=name,
                               in_sig=in_sig,
                               out_sig=out_sig,
                               # Upstream passes GW_BLOCK_DECIM here too; only
                               # GW_BLOCK_GENERAL is treated differently.
                               block_type=GW_BLOCK_DECIM)
        self._decim = 1
        self._interp = interp
        self.gateway.set_relative_rate(self._interp, self._decim)
        self.gateway.set_output_multiple(self._interp)

    def forecast(self, noutput_items, ninputs):
        return [self.fixed_rate_noutput_to_ninput(noutput_items)] * ninputs

    def consume_items(self, nitems):
        if nitems > 0:
            self.gateway.consume_each(int(nitems / self._interp))
