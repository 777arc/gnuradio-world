// Browser-native C++ ports of gr-adsb's pure-Python GNU Radio blocks.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// gr-adsb ships no C++ blocks: its lib/ holds only the QA harness, and the
// framer, demodulator and decoder are all Python gr.sync_block subclasses under
// gr-adsb/python/adsb/. Each class in adsb_blocks.cpp mirrors the Python file
// named in its comment there, so the two stay diffable.
#pragma once

#include <gnuradio/basic_block.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/sync_block.h>

#include <memory>
#include <string>

namespace wasm_adsb {

// framer.py -- squared-magnitude samples in, the same samples out, with a
// "burst" tag carrying ("SOB", snr) at the start of every detected preamble.
//
// Unlike the other two this one is declared rather than hidden behind a
// basic_block_sptr, because its GRC yaml carries a `set_threshold` callback: the
// generated factory installs a numeric setter that calls straight through this
// interface, which is what lets a QT GUI Range drive the detection threshold
// while the flowgraph runs.
class framer : public gr::sync_block
{
public:
    virtual void set_threshold(double threshold) = 0;

protected:
    framer(const std::string& name,
           gr::io_signature::sptr input_signature,
           gr::io_signature::sptr output_signature)
        : gr::sync_block(name, input_signature, output_signature)
    {
    }
};

using framer_sptr = std::shared_ptr<framer>;

framer_sptr make_framer(double fs, double threshold);

// demod.py -- consumes those tags and publishes one 112-bit u8vector PDU per
// burst on the "demodulated" port; the sample stream passes through untouched.
gr::basic_block_sptr make_demod(double fs);

// decoder.py -- Mode S / ADS-B message decoder. Takes the demodulated PDUs and
// publishes the aircraft state it recovers on "decoded", anything it cannot
// interpret on "unknown".
gr::basic_block_sptr make_decoder(const std::string& msg_filter,
                                  const std::string& error_corr,
                                  const std::string& print_level);

} // namespace wasm_adsb
