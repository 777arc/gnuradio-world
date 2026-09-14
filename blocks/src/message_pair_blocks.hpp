#pragma once

// C++ rebuilds of gr-blocks' three Python message-pair utilities
// (gr-blocks/python/blocks/{var_to_msg,msg_pair_to_var,msg_meta_to_pair}.py):
// the blocks that carry a flowgraph *variable* into and out of the message
// domain, and the one that picks a metadata field out of a PDU as a pair.
//
// Native GRC gives the first two their variable through generated Python:
// Variable to Message's `variable_changed(${target})` callback is re-run
// whenever the variable changes, and Message Pair to Var calls the flowgraph's
// `set_<target>()`. There is no generated Python here, so both go through the
// runner's live-control machinery instead -- see the factories in
// runner/src/registry.cpp and the binding loop in runner/src/runner.cpp -- and
// only a *control* (a QT GUI Range and friends) is a variable that exists at
// run time. A plain `variable` is inlined by the runner's lowering step, so
// naming one here is a message that never fires, exactly as it is natively
// for a variable nothing ever sets.

#include <gnuradio/block.h>
#include <gnuradio/io_signature.h>
#include <pmt/pmt.h>
#include <atomic>
#include <cmath>
#include <functional>
#include <mutex>
#include <string>

// blocks.var_to_msg_pair: publish (pairname . value) on `msgout` whenever the
// watched variable changes. The runner drives set_value() from the control's
// subscriber list; nothing is published at start, as nothing is natively.
class VarToMsgPair : public gr::block
{
public:
    using sptr = std::shared_ptr<VarToMsgPair>;
    static sptr make(const std::string& pairname)
    {
        return gnuradio::make_block_sptr<VarToMsgPair>(pairname);
    }

    explicit VarToMsgPair(const std::string& pairname)
        : gr::block("var_to_msg_pair",
                    gr::io_signature::make(0, 0, 0),
                    gr::io_signature::make(0, 0, 0)),
          d_pairname(pmt::intern(pairname))
    {
        message_port_register_out(d_port);
    }

    // Upstream types the PMT after the Python value; a control's value is a
    // double here, and one that is a whole number was almost certainly an int
    // Range, so it goes out as the long the native flowgraph would send.
    void set_value(double value)
    {
        const bool integral = std::isfinite(value) && value == std::floor(value) &&
                              std::fabs(value) < 9.0e15;
        message_port_pub(
            d_port,
            pmt::cons(d_pairname,
                      integral ? pmt::from_long(static_cast<long>(value))
                               : pmt::from_double(value)));
    }

private:
    const pmt::pmt_t d_port = pmt::intern("msgout");
    pmt::pmt_t d_pairname;
};

// blocks.msg_pair_to_var: on a (name . value) pair, set the flowgraph variable.
// The sink is installed by the runner once it knows which control the `target`
// parameter names; until then an arriving pair is dropped with a warning, the
// way upstream's handler logs a callback it cannot make.
class MsgPairToVar : public gr::block
{
public:
    using sptr = std::shared_ptr<MsgPairToVar>;
    static sptr make() { return gnuradio::make_block_sptr<MsgPairToVar>(); }

    MsgPairToVar()
        : gr::block("msg_pair_to_var",
                    gr::io_signature::make(0, 0, 0),
                    gr::io_signature::make(0, 0, 0))
    {
        message_port_register_in(d_port);
        set_msg_handler(d_port, [this](const pmt::pmt_t& msg) { handle(msg); });
    }

    void set_sink(std::function<void(double)> sink)
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        d_sink = std::move(sink);
    }

private:
    void handle(const pmt::pmt_t& msg)
    {
        if (!pmt::is_pair(msg) || pmt::is_dict(msg) || pmt::is_pdu(msg)) {
            d_logger->warn("Input message {} is not a simple pair, dropping",
                           pmt::write_string(msg));
            return;
        }
        const pmt::pmt_t value = pmt::cdr(msg);
        double number = 0.0;
        if (pmt::is_bool(value))
            number = pmt::to_bool(value) ? 1.0 : 0.0;
        else if (pmt::is_number(value))
            number = pmt::to_double(value);
        else {
            d_logger->warn("Cannot set the variable from {}: not a number",
                           pmt::write_string(value));
            return;
        }
        std::function<void(double)> sink;
        {
            std::lock_guard<std::mutex> lock(d_mutex);
            sink = d_sink;
        }
        if (!sink) {
            // The name is gone by now when it was a plain variable: the
            // runner's lowering step inlines those, so the parameter arrived
            // holding the value rather than the name.
            if (!d_warned.exchange(true))
                d_logger->warn("target is not a QT GUI control in this flowgraph, so "
                               "there is nothing to set (a plain variable cannot be "
                               "changed at run time); point it at a QT GUI Range");
            return;
        }
        sink(number);
    }

    const pmt::pmt_t d_port = pmt::intern("inpair");
    std::mutex d_mutex;
    std::function<void(double)> d_sink;
    std::atomic<bool> d_warned{ false };
};

// blocks.meta_to_pair: (keyout . meta[keyin]) on `outpair` for each PDU (or any
// pair whose car is a dictionary) arriving on `inmeta`.
class MetaToPair : public gr::block
{
public:
    using sptr = std::shared_ptr<MetaToPair>;
    static sptr make(const std::string& keyin, const std::string& keyout)
    {
        return gnuradio::make_block_sptr<MetaToPair>(keyin, keyout);
    }

    MetaToPair(const std::string& keyin, const std::string& keyout)
        : gr::block("meta_to_pair",
                    gr::io_signature::make(0, 0, 0),
                    gr::io_signature::make(0, 0, 0)),
          d_keyin(pmt::intern(keyin)),
          d_keyout(pmt::intern(keyout))
    {
        message_port_register_in(d_in);
        message_port_register_out(d_out);
        set_msg_handler(d_in, [this](const pmt::pmt_t& msg) { handle(msg); });
    }

private:
    void handle(const pmt::pmt_t& msg)
    {
        if (!pmt::is_pair(msg)) {
            d_logger->warn("Incoming message is not a pair.  Only pairs are supported.  "
                           "No message generated.");
            return;
        }
        const pmt::pmt_t meta = pmt::car(msg);
        if (!pmt::is_dict(meta)) {
            d_logger->warn("Incoming message does not contain a dictionary.  "
                           "No message generated.");
            return;
        }
        if (!pmt::dict_has_key(meta, d_keyin)) {
            d_logger->warn("Incoming message dictionary does not contain key {}.  "
                           "No message generated.",
                           pmt::symbol_to_string(d_keyin));
            return;
        }
        message_port_pub(d_out,
                         pmt::cons(d_keyout, pmt::dict_ref(meta, d_keyin, pmt::PMT_NIL)));
    }

    const pmt::pmt_t d_in = pmt::intern("inmeta");
    const pmt::pmt_t d_out = pmt::intern("outpair");
    pmt::pmt_t d_keyin, d_keyout;
};
